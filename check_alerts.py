import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('178.128.186.243', username='root', password='fVlo271712a', timeout=10)

stdin, stdout, stderr = client.exec_command('grep -i "alert\|compra\|purchase\|NIX\|SNAP\|2500\|5000" /root/jh/bot.log 2>/dev/null | grep -v "INICIANDO\|Lamina\|schedule" | tail -40')
print('=== Purchases/Alerts ===')
print(stdout.read().decode('utf-8', errors='ignore'))

client.close()