import paramiko
import json

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('178.128.186.243', username='root', password='fVlo271712a', timeout=10)

stdin, stdout, stderr = client.exec_command('cat /root/jh/allowed_groups.json 2>/dev/null')
data = stdout.read().decode('utf-8', errors='ignore')
print(data[:3000])

stdin2, stdout2, stderr2 = client.exec_command('grep -i "CRIPTO_NO_PIX_GROUPS\|BUY_ALERT_GROUPS\|allowed.*group" /root/jh/.env 2>/dev/null')
print('\n=== ENV Groups ===')
print(stdout2.read().decode('utf-8', errors='ignore'))

client.close()