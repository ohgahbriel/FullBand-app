!macro customInstall
  DetailPrint "Installing Microsoft Visual C++ Redistributable (required by the audio engine)..."
  ExecWait '"$INSTDIR\resources\vc_redist.x64.exe" /install /quiet /norestart'
!macroend
