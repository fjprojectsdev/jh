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

    PROJECT = "/root/jh"

    # Get file size
    out = run_ssh(client, f"wc -l {PROJECT}/functions/groupResponder.js")
    print(f"File lines on VPS: {out.strip()}")

    # Read local file content
    with open("functions/groupResponder.js", "r", encoding="utf-8", errors="replace") as f:
        local_content = f.read()

    # Write to VPS
    print("Uploading groupResponder.js...")
    sftp = client.open_sftp()
    with sftp.file(f"{PROJECT}/functions/groupResponder.js", "w") as remote_file:
        remote_file.write(local_content)

    # Verify
    out2 = run_ssh(client, f"wc -l {PROJECT}/functions/groupResponder.js")
    print(f"File lines after upload: {out2.strip()}")

    # Restart bot
    print("\nRestarting bot...")
    run_ssh(client, "pm2 restart imavy-main")
    time.sleep(5)

    # Check logs
    print("\nLogs:")
    print(run_ssh(client, "pm2 logs imavy-main --lines 20 --nostream 2>/dev/null"))

    sftp.close()
    client.close()
    print("\nDone!")

if __name__ == "__main__":
    main()