@echo off
title iMavyBot Dashboard
color 0A

echo ========================================
echo    iMavyBot Dashboard - Iniciando
echo ========================================
echo.

cd dashboard

echo [1/3] Verificando dependencias...
if not exist "node_modules\" (
    echo Instalando dependencias...
    call npm install
) else (
    echo Dependencias ja instaladas!
)

echo.
echo [2/3] Iniciando servidor...
echo.
echo Dashboard disponivel em: http://localhost:3000
echo Senha padrao: FJMR2025
echo.
echo [3/3] Pressione Ctrl+C para parar o servidor
echo.

call npm start

pause
