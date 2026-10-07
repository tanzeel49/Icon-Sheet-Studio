@echo off
echo =======================================================
echo Downloading Microsoft Visual Studio C++ Build Tools...
echo =======================================================
powershell -Command "Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vs_BuildTools.exe' -OutFile 'vs_BuildTools.exe'"

echo =======================================================
echo Installing C++ Build Tools (This may take 10-15 minutes)
echo A window may not appear, please wait until this finishes...
echo =======================================================
vs_BuildTools.exe --quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended

echo =======================================================
echo Installation Complete. Cleaning up...
echo =======================================================
del vs_BuildTools.exe
echo Please restart your computer, then run: bun run desktop:build
pause
