import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('178.128.186.243', username='root', password='fVlo271712a', timeout=10)

stdin, stdout, stderr = client.exec_command('grep -i "PIX\|CRIPTO\|CNP\|WEBHOOK\|site" /root/jh/.env 2>/dev/null')
print(stdout.read().decode('utf-8', errors='ignore'))

client.close()