import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('178.128.186.243', username='root', password='fVlo271712a', timeout=10)

stdin, stdout, stderr = client.exec_command('grep -i "nova compra\|criptoNoPix\|processando" /root/jh/bot.log 2>/dev/null | tail -30')
print('=== Purchases in bot.log ===')
print(stdout.read().decode('utf-8', errors='ignore'))

client.close()