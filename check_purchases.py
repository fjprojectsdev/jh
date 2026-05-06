import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('178.128.186.243', username='root', password='fVlo271712a', timeout=10)

stdin, stdout, stderr = client.exec_command('tail -2000 /root/.pm2/logs/imavy-main-out.log 2>/dev/null | grep -i "Nova compra\|Compra detectada\|Processando\|Purchase\|purchase" | tail -20')
print(stdout.read().decode('utf-8', errors='ignore'))
print('\n=== IGNORED ===')
stdin2, stdout2, stderr2 = client.exec_command('tail -2000 /root/.pm2/logs/imavy-main-out.log 2>/dev/null | grep -i "sendSafeMessage\|Ignorado" | tail -20')
print(stdout2.read().decode('utf-8', errors='ignore'))

client.close()