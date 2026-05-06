import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('178.128.186.243', username='root', password='fVlo271712a', timeout=10)

stdin, stdout, stderr = client.exec_command('grep -r "3000\|webhook\|purchase" /root/jh/.env /root/jh/*.json /root/jh/ecosystem.config.js 2>/dev/null | grep -v "^grep"')
print(stdout.read().decode('utf-8', errors='ignore'))

stdin2, stdout2, stderr2 = client.exec_command('ls -la /root/jh/')
print('\n=== Files in /root/jh/ ===')
print(stdout2.read().decode('utf-8', errors='ignore'))

client.close()