import paramiko

HOST = "178.128.186.243"
USER = "root"
PASSWORD = "fVlo271712a"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30)

def run(cmd):
    stdin, stdout, stderr = client.exec_command(cmd)
    return stdout.read().decode('utf-8', errors='replace')

try:
    out = run("pm2 status")
    print(out.encode('ascii', errors='replace').decode('ascii'))
except Exception as e:
    print(f"Error: {e}")

client.close()