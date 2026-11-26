Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
repoRoot = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = repoRoot
cmd = "cmd.exe /c node """ & repoRoot & "\app\server.mjs"""
sh.Run cmd, 0, False
