' Starts broker.cjs hidden (no console window). Put a copy (or a shortcut) in your Windows Startup folder
' (Win+R, "shell:startup") to run the broker at logon. The patched MCP server also starts it on demand by
' running this file from the Startup folder, or `node broker.cjs` directly if it is not there.
' Edit the two paths below, or set them once with environment variables PW_MCP_NODE and PW_MCP_BROKER.
Dim sh, node, broker
Set sh = CreateObject("WScript.Shell")
node = sh.ExpandEnvironmentStrings("%PW_MCP_NODE%")
If node = "%PW_MCP_NODE%" Then node = "C:\Program Files\nodejs\node.exe"
broker = sh.ExpandEnvironmentStrings("%PW_MCP_BROKER%")
If broker = "%PW_MCP_BROKER%" Then broker = "C:\path\to\playwright-mcp-background\broker.cjs"
sh.Run """" & node & """ """ & broker & """", 0, False
