import paramiko
import time
import sys
import io

# Forcar UTF-8 no stdout do Windows
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

HOST = "178.128.186.243"
USER = "root"
PASSWORD = "fVlo271712a"
PROJECT = "/root/jh"
DEV_PHONE = "5569993613476"

def run_ssh(client, command, print_output=True):
    stdin, stdout, stderr = client.exec_command(command)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    if print_output:
        if out.strip():
            print(out.strip())
        if err.strip():
            print(f"[stderr] {err.strip()}")
    return out

def main():
    print("=" * 50)
    print("  DEPLOY VPS - iMavy Bot")
    print("=" * 50)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"\n[1/6] Conectando a {HOST}...")
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30)
    print("      Conectado!")

    # 1. Limpar arquivos não rastreados e fazer stash das alterações locais na VPS
    print(f"\n[2/6] Limpando arquivos não rastreados e fazendo stash na VPS...")
    run_ssh(client, f"cd {PROJECT} && git clean -fd && git stash 2>&1")

    # 2. git pull
    print(f"\n[3/6] Fazendo git pull em {PROJECT}...")
    run_ssh(client, f"cd {PROJECT} && git pull origin main 2>&1")

    # 3. Garantir DEV_PHONE no .env
    print(f"\n[4/6] Atualizando DEV_PHONE no .env da VPS...")
    run_ssh(client, f"cd {PROJECT} && sed -i '/^DEV_PHONE=/d' .env && echo 'DEV_PHONE={DEV_PHONE}' >> .env", print_output=False)
    verify = run_ssh(client, f"grep 'DEV_PHONE' {PROJECT}/.env", print_output=False)
    print(f"      .env: {verify.strip()}")

    # 4. Reiniciar bot
    print("\n[5/6] Reiniciando bot...")
    run_ssh(client, f"cd {PROJECT} && pm2 restart imavy-main", print_output=False)
    time.sleep(8)

    # 5. Status e logs
    print("\n[6/6] Verificando status...")
    status = run_ssh(client, "pm2 jlist 2>/dev/null", print_output=False)
    # Mostrar apenas status simplificado
    run_ssh(client, "pm2 list 2>/dev/null | cat")

    print("\n--- Ultimas linhas do log ---")
    logs = run_ssh(client, "pm2 logs imavy-main --lines 20 --nostream 2>/dev/null", print_output=False)
    # Filtrar apenas linhas relevantes
    lines = [l for l in logs.splitlines() if l.strip() and not l.strip().startswith('[PM2]')]
    print('\n'.join(lines[-20:]))

    client.close()
    print("\n" + "=" * 50)
    print("  Deploy concluido com sucesso!")
    print("=" * 50)

if __name__ == "__main__":
    main()
