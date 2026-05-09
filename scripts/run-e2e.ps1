$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
& "C:\Program Files\Git\bin\bash.exe" "D:\N8N\Projekte\Databorg\borghive\scripts\e2e-test.sh"
