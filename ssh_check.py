import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('178.128.186.243', username='root', password='fVlo271712a', timeout=10)

# Verificar se ha configuracao de webhook do CNP
stdin, stdout, stderr = client.exec_command('grep -i "CNP\|cnp\|site.*compra\|webhook.*cnp" /root/jh/.env')
result = stdout.read()
print('=== Config CNP no .env ===')
print(result.decode('utf-8', errors='ignore'))

# Verificar se ha algum endpoint no dashboard para compras do site
stdin, stdout, stderr = client.exec_command('grep -i "site.*compra\|compra.*site\|purchase.*webhook\|/api.*purchase" /root/jh/.env')
result2 = stdout.read()
print('\n=== Webhook Compras ===')
print(result2.decode('utf-8', errors='ignore'))

client.close()