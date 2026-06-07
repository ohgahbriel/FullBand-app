' FullBand — silent launcher. Opens the app with no console window.
' (Double-click this instead of FullBand.bat for the clean, log-free launch.)
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base    = fso.GetParentFolderName(WScript.ScriptFullName)
electronExe = base & "\desktop\node_modules\electron\dist\electron.exe"
appDir      = base & "\desktop"
' Clear ELECTRON_RUN_AS_NODE so Electron runs as the app, not plain Node.
On Error Resume Next
sh.Environment("PROCESS").Remove("ELECTRON_RUN_AS_NODE")
On Error GoTo 0
' 0 = hidden window (no console); False = don't wait.
sh.Run """" & electronExe & """ """ & appDir & """", 0, False
