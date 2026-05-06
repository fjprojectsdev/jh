import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('178.128.186.243', username='root', password='fVlo271712a', timeout=10)

stdin, stdout, stderr = client.exec_command('curl -s http://localhost:3000/api/cnp-purchase-alert 2>/dev/null || echo "not found"')
print(stdout.read().decode('utf-8', errors='ignore'))

stdin2, stdout2, stderr2 = client.exec_command('grep -i "WEBHOOK_URL\|CNP_WEBHOOK\|site.*webhook\|purchase.*alert" /root/jh/.env 2>/dev/null')
print('\n=== Webhook config ===')
print(stdout2.read().decode('utf-8', errors='ignore'))

client.close()