import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('178.128.186.243', username='root', password='fVlo271712a', timeout=10)

stdin, stdout, stderr = client.exec_command('tail -500 /root/.pm2/logs/imavy-main-out.log 2>/dev/null | grep -i "criptoNoPix\|cripto_no_pix\|NIX\|SNAP\|compra\|buy\|process" | tail -30')
print(stdout.read().decode('utf-8', errors='ignore'))
print('\n=== ERRORS ===')
stdin2, stdout2, stderr2 = client.exec_command('tail -500 /root/.pm2/logs/imavy-main-out.log 2>/dev/null | grep -i "error\|Error\|ERRO" | tail -10')
print(stdout2.read().decode('utf-8', errors='ignore'))

client.close()