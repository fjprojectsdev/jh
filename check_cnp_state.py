import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('178.128.186.243', username='root', password='fVlo271712a', timeout=10)

stdin, stdout, stderr = client.exec_command('cat /root/jh/buy_alert_cripto_no_pix_state.json 2>/dev/null')
print('=== CNP State ===')
print(stdout.read().decode('utf-8', errors='ignore'))

stdin2, stdout2, stderr2 = client.exec_command('stat /root/jh/buy_alert_cripto_no_pix_state.json 2>/dev/null')
print('=== Last Modified ===')
print(stdout2.read().decode('utf-8', errors='ignore'))

client.close()