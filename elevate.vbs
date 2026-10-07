Set UAC = CreateObject("Shell.Application")
UAC.ShellExecute "vs_BuildTools.exe", "--quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended", "", "runas", 1
