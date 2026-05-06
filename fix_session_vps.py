import paramiko
import time
import re

HOST = "178.128.186.243"
USER = "root"
PASSWORD = "fVlo271712a"

def safe_print(s):
    try:
        print(s.encode('ascii', errors='replace').decode('ascii'))
    except Exception:
        pass

def run_ssh(client, command):
    stdin, stdout, stderr = client.exec_command(command)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    if err and err.strip():
        safe_print(f"  [STDERR] {err.strip()}")
    return out

def main():
    print("=" * 60)
    print("Conectando na VPS...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30)
    print("OK!")

    print("\n--- PM2 Status ---")
    output = run_ssh(client, "pm2 status")
    safe_print(output)

    project_path = "/root/jh"

    print("\n--- Verificando pastas de sessao em /root/jh ---")
    out = run_ssh(client, "ls -la /root/jh/auth_info 2>/dev/null | head -20 && echo '---' && ls /root/jh/auth_info 2>/dev/null | wc -l && echo 'files in auth_info'")
    safe_print(out)
    out2 = run_ssh(client, "ls -la /root/jh/auth_backup 2>/dev/null | head -20 && echo '---' && ls /root/jh/auth_backup 2>/dev/null | wc -l && echo 'files in auth_backup'")
    safe_print(out2)

    print("\n--- Parando bot ---")
    run_ssh(client, "pm2 stop imavy-main 2>/dev/null")
    time.sleep(3)
    safe_print(run_ssh(client, "pm2 status"))

    print("\n--- Renomeando sessoes ---")
    ts = time.strftime("%Y%m%d_%H%M%S")
    auth_info_renamed = False
    auth_backup_renamed = False

    out1 = run_ssh(client, f"cd /root/jh && test -d auth_info && mv auth_info auth_info_badmac_{ts} && echo 'OK auth_info' || echo 'NO auth_info'")
    safe_print(out1)
    if "OK" in out1:
        auth_info_renamed = True

    out2 = run_ssh(client, f"cd /root/jh && test -d auth_backup && mv auth_backup auth_backup_badmac_{ts} && echo 'OK auth_backup' || echo 'NO auth_backup'")
    safe_print(out2)
    if "OK" in out2:
        auth_backup_renamed = True

    if not auth_info_renamed:
        print("AVISO: auth_info nao foi renomeada. Tentando encontrar...")
        dirs = run_ssh(client, "find /root/jh -maxdepth 2 -name 'auth_info' -type d 2>/dev/null")
        safe_print(dirs)
        for d in dirs.strip().split("\n"):
            if d:
                run_ssh(client, f"mv {d} /root/jh/auth_info_badmac_{ts} && echo 'OK'")
                break

    print(f"\n--- Iniciando bot (sessoes renomeadas: auth_info={auth_info_renamed}, auth_backup={auth_backup_renamed}) ---")
    run_ssh(client, "pm2 start imavy-main 2>/dev/null")
    time.sleep(10)

    print("\n--- Logs (procurar QR code ou conexao) ---")
    for i in range(8):
        out_log = run_ssh(client, "pm2 logs imavy-main --lines 40 --nostream 2>/dev/null")
        safe_print(out_log)
        if any(w in out_log for w in ["AUTENTICACAO", "escanear", "QR CODE DISPONIVEL", "Conectado", "Conectado ao WhatsApp", "open"]):
            print("Sinal de conexao/QR detectado!")
            break
        if "Bad MAC" in out_log:
            print("AVISO: Bad MAC ainda aparece!")
        time.sleep(5)

    print("\n--- Status final PM2 ---")
    safe_print(run_ssh(client, "pm2 status"))

    print("\n--- Verificar se nova sessao foi criada ---")
    out3 = run_ssh(client, "ls /root/jh/auth_info 2>/dev/null | wc -l && echo 'files in auth_info' || echo 'auth_info nao existe'")
    safe_print(out3)
    out4 = run_ssh(client, "ls /root/jh/auth_backup 2>/dev/null | wc -l && echo 'files in auth_backup' || echo 'auth_backup nao existe'")
    safe_print(out4)

    client.close()
    print("\nFeito! Escaneie o QR code se solicitado.")

if __name__ == "__main__":
    main()