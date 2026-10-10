"""Run native workload lifecycle checks with standard Google Cloud SDKs."""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import uuid
import grpc
from google.auth.credentials import AnonymousCredentials

profile = sys.argv[1]
project = os.environ['GOOGLE_CLOUD_PROJECT']
name = 'ci-' + uuid.uuid4().hex[:12]
parent = f'projects/{project}/locations/us-central1'


def channel(key):
    endpoint = os.environ[key]
    parsed = urllib.parse.urlsplit('http://' + endpoint.removeprefix('http://'))
    assert parsed.hostname in {'localhost', '127.0.0.1', 'localcloud'}, endpoint
    assert parsed.port and not parsed.username and not parsed.password
    return grpc.insecure_channel(parsed.netloc)


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, timeout=600).strip()


if profile == 'cloudrun':
    from google.cloud import run_v2
    from google.cloud.run_v2.services.services.transports.grpc import ServicesGrpcTransport
    fixture = 'localcloud-ci-fixture-' + uuid.uuid4().hex
    image = 'localcloud-ci-app:' + uuid.uuid4().hex
    client = run_v2.ServicesClient(transport=ServicesGrpcTransport(channel=channel('CLOUD_RUN_EMULATOR_HOST')))
    created = False
    try:
        docker('create', '--pull=never', '--name', fixture, '--entrypoint', '/opt/localcloud/pyenv/bin/python3', os.environ['LOCALCLOUD_SOURCE_IMAGE'], '-m', 'http.server', '8080')
        with tempfile.TemporaryDirectory() as directory:
            with open(directory + '/index.html', 'w') as file:
                file.write('LOCALCLOUD_CI_HTTP_OK')
            docker('cp', directory + '/.', fixture + ':/ci-app')
        docker('commit', '--change', 'WORKDIR /ci-app', fixture, image)
        created = True
        operation = client.create_service(parent=parent, service_id=name, service=run_v2.Service(template={'containers': [{'image': image, 'ports': [{'container_port': 8080}]}]}), timeout=30)
        service = operation.result(timeout=180)
        service = client.get_service(name=service.name, timeout=30)
        uri = urllib.parse.urlsplit(service.uri)
        assert uri.scheme == 'http' and (uri.hostname in {'localhost', '127.0.0.1', 'host.docker.internal'} or uri.hostname.endswith('.localhost')), service.uri
        with urllib.request.urlopen(service.uri, timeout=30) as response:
            assert b'LOCALCLOUD_CI_HTTP_OK' in response.read()
        print('Cloud Run: SDK deployment, native HTTP execution and readback passed')
    finally:
        if created:
            try: client.delete_service(name=f'{parent}/services/{name}', timeout=30).result(timeout=180)
            except Exception as error: print('Cloud Run deletion:', error, file=sys.stderr)
        try: docker('rm', '-f', '-v', fixture)
        except subprocess.CalledProcessError: pass
        try: docker('rmi', image)
        except subprocess.CalledProcessError: pass
        client.transport.close()
elif profile == 'dataproc':
    from google.cloud import dataproc_v1, storage
    from google.cloud.dataproc_v1.services.cluster_controller.transports.grpc import ClusterControllerGrpcTransport
    from google.cloud.dataproc_v1.services.job_controller.transports.grpc import JobControllerGrpcTransport
    controller = dataproc_v1.ClusterControllerClient(transport=ClusterControllerGrpcTransport(channel=channel('DATAPROC_EMULATOR_HOST')))
    jobs = dataproc_v1.JobControllerClient(transport=JobControllerGrpcTransport(channel=channel('DATAPROC_EMULATOR_HOST')))
    objects = storage.Client(project=project, credentials=AnonymousCredentials())
    bucket = objects.bucket(name); created = False
    try:
        bucket.create()
        bucket.blob('check.py').upload_from_string("from pyspark.sql import SparkSession\nspark=SparkSession.builder.getOrCreate()\nassert spark.range(5).count()==5\nprint('LOCALCLOUD_CI_SPARK_OK')\nspark.stop()\n")
        operation = controller.create_cluster(project_id=project, region='us-central1', cluster={'project_id': project, 'cluster_name': name, 'config': {'master_config': {'num_instances': 1}, 'worker_config': {'num_instances': 0}, 'software_config': {'image_version': '3.0.0-debian13'}}}, timeout=30)
        created = True
        operation.result(timeout=240)
        job = jobs.submit_job(project_id=project, region='us-central1', job={'placement': {'cluster_name': name}, 'pyspark_job': {'main_python_file_uri': f'gs://{name}/check.py'}}, timeout=30)
        deadline = time.monotonic() + 240
        while job.status.state not in {dataproc_v1.JobStatus.State.DONE, dataproc_v1.JobStatus.State.ERROR, dataproc_v1.JobStatus.State.CANCELLED}:
            assert time.monotonic() < deadline, 'Dataproc job deadline exceeded'
            time.sleep(2)
            job = jobs.get_job(project_id=project, region='us-central1', job_id=job.reference.job_id, timeout=30)
        assert job.status.state == dataproc_v1.JobStatus.State.DONE, job.status
        print('Dataproc: SDK cluster creation and native Spark job passed')
    finally:
        deletion_error = None
        if created:
            try: controller.delete_cluster(project_id=project, region='us-central1', cluster_name=name, timeout=30).result(timeout=180)
            except Exception as error: deletion_error = error
        try: bucket.delete(force=True)
        except Exception: pass
        objects.close(); controller.transport.close(); jobs.transport.close()
        if deletion_error:
            raise RuntimeError('Dataproc SDK deletion failed; a corrected runtime image is required') from deletion_error
elif profile == 'gke':
    from google.cloud import container_v1
    from google.cloud.container_v1.services.cluster_manager.transports.grpc import ClusterManagerGrpcTransport
    client = container_v1.ClusterManagerClient(transport=ClusterManagerGrpcTransport(channel=channel('GKE_EMULATOR_HOST')))
    location = f'projects/{project}/locations/us-central1-a'
    created = False
    try:
        operation = client.create_cluster(parent=location, cluster={'name': name, 'initial_node_count': 1}, timeout=30)
        created = True
        deadline = time.monotonic() + 240
        while operation.status != container_v1.Operation.Status.DONE:
            assert time.monotonic() < deadline, 'GKE creation deadline exceeded'
            time.sleep(2)
            operation_name = operation.name if operation.name.startswith('projects/') else f'{location}/operations/{operation.name}'
            operation = client.get_operation(name=operation_name, timeout=30)
        assert not operation.error.code, operation.error
        cluster = client.get_cluster(name=f'{location}/clusters/{name}', timeout=30)
        assert cluster.status == container_v1.Cluster.Status.RUNNING, cluster.status
        assert cluster.endpoint, 'Native Kubernetes API endpoint missing'
        servers = docker('ps', '-q', '--no-trunc', '--filter', 'label=com.localcloud.volume-name=' + os.environ['LOCALCLOUD_TEST_VOLUME'], '--filter', 'label=localcloud.service=gke').splitlines()
        assert len(servers) == 1, servers
        node = servers[0]
        version = json.loads(docker('exec', node, 'kubectl', 'get', '--raw', '/version'))
        assert version['gitVersion'].startswith('v'), version
        docker('exec', node, 'kubectl', 'wait', '--for=condition=Ready', 'node', '--all', '--timeout=90s')
        cached = docker('exec', node, 'ctr', '-n', 'k8s.io', 'images', 'ls', '-q').splitlines()
        pause = next((image for image in cached if '/mirrored-pause' in image or '/pause' in image), 'registry.k8s.io/pause@sha256:ee6521f290b2168b6e0935a181d4cff9be1ac3f505666ef0e3c98fae8199917a')
        docker('exec', node, 'kubectl', 'run', name, '--image=' + pause, '--image-pull-policy=IfNotPresent', '--restart=Never')
        docker('exec', node, 'kubectl', 'wait', '--for=condition=Ready', 'pod/' + name, '--timeout=90s')
        print('GKE: SDK lifecycle, native Kubernetes API, ready node and native pod execution passed')
    finally:
        if created:
            try: client.delete_cluster(name=f'{location}/clusters/{name}', timeout=30)
            except Exception as error: print('GKE deletion:', error, file=sys.stderr)
        client.transport.close()
else:
    raise ValueError('Expected cloudrun, dataproc or gke')
