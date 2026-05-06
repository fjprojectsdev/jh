import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('178.128.186.243', username='root', password='fVlo271712a', timeout=10)

stdin, stdout, stderr = client.exec_command('grep "CRIPTO_NO_PIX_GROUPS" /root/jh/.env 2>/dev/null')
print('CRIPTO_NO_PIX_GROUPS:', stdout.read().decode('utf-8', errors='ignore').strip())

stdin2, stdout2, stderr2 = client.exec_command('grep "ENABLE_" /root/jh/.env 2>/dev/null')
print('\n=== ENABLE flags ===')
print(stdout2.read().decode('utf-8', errors='ignore'))

client.close()