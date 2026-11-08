@echo off
rem Previous Pimi releases installed shell trampolines to this filename.
call "%~dp0pimi.cmd" %*
exit /b %errorlevel%
