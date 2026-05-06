import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('178.128.186.243', username='root', password='fVlo271712a', timeout=10)

stdin, stdout, stderr = client.exec_command('cat /root/jh/.env | grep -E "ENABLE_NIX|ENABLE_SNAP|ENABLE_CRIPTO"')
print(stdout.read().decode('utf-8', errors='ignore'))
print(stderr.read().decode('utf-8', errors='ignore'))

client.close()