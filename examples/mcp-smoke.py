"""Verify a real MCP client attaches to the SDK runtime and selected project."""
import asyncio
import json
import os
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main():
    with open(os.environ['LOCALCLOUD_MCP_CONFIG']) as file:
        server = json.load(file)['mcpServers']['localcloud']
    connection = json.loads(server['env']['LOCALCLOUD_MCP_CONNECTION'])
    parameters = StdioServerParameters(command=server['command'], args=server['args'],
                                      env={**os.environ, **server['env']})
    async with stdio_client(parameters) as (read, write):
        async with ClientSession(read, write) as session:
            initialized = await session.initialize()
            assert initialized.serverInfo.name == 'localcloud'
            tools = await session.list_tools()
            assert any(tool.name == 'localcloud_get_env' for tool in tools.tools)
            assert all(isinstance(tool.inputSchema.get('properties', {}), dict) for tool in tools.tools)
            resources = await session.list_resources()
            assert any(str(resource.uri) == 'localcloud://api/catalog' for resource in resources.resources)
            environment = await session.call_tool('localcloud_get_env', {'format': 'json', 'project': connection['project']})
            assert not environment.isError
            values = environment.structuredContent['result']
            assert values['GOOGLE_CLOUD_PROJECT'] == os.environ['GOOGLE_CLOUD_PROJECT']
            assert values['BIGQUERY_EMULATOR_HOST'] == os.environ['BIGQUERY_EMULATOR_HOST']
            query = await session.call_tool('localcloud_query_data', {'service': 'bigquery', 'sql': 'SELECT 1 AS ok', 'project': connection['project']})
            assert not query.isError
            result = json.loads(query.structuredContent['result'])
            assert result.get('row_count') == 1 or len(result.get('rows', [])) == 1, result
            print('MCP initialize, tools/resources, SDK environment and local SQL passed')


asyncio.run(main())
