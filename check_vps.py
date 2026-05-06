import paramiko
import time

HOST = "178.128.186.243"
USER = "root"
PASSWORD = "fVlo271712a"

def run_ssh(client, command):
    stdin, stdout, stderr = client.exec_command(command)
    return stdout.read().decode('utf-8', errors='replace')

def main():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30)

    print("Verificando conexao do bot (Bad MAC deve parar apos escanear QR)...")
    for i in range(12):
        logs = run_ssh(client, "pm2 logs imavy-main --lines 50 --nostream 2>/dev/null")
        badmac_count = logs.count("Bad MAC")
        print(f"\n[{i+1}] Bad MAC count: {badmac_count}")
        if "Conectado" in logs or "open" in logs or "Status da conexao: open" in logs:
            print("CONECTADO!")
            break
        if badmac_count == 0 and ("open" in logs or "AUTENTICACAO" not in logs):
            print("Sem Bad MAC! Conexao parece estable.")
            break
        time.sleep(10)

    print("\n--- Logs recentes ---")
    print(run_ssh(client, "pm2 logs imavy-main --lines 30 --nostream 2>/dev/null")[-2000:])
    print("\n--- PM2 status ---")
    print(run_ssh(client, "pm2 status"))

    client.close()

if __name__ == "__main__":
    main()