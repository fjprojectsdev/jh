import paramiko

HOST = "178.128.186.243"
USER = "root"
PASSWORD = "fVlo271712a"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30)

def run(cmd):
    stdin, stdout, stderr = client.exec_command(cmd)
    return stdout.read().decode('utf-8', errors='replace')

key_funcs = [
    "configureIntervalReminder",
    "configureFixedReminder",
    "buildIntervalReminderSelection",
    "stopSingleReminder",
    "buildEditableReminderItems",
    "handleGroupMessages",
    "initLembretes",
    "saveLembretes",
    "startLembreteFixo",
    "stopLembreteFixo",
    "restartLembrete",
    "stopReminder"
]

for func in key_funcs:
    out = run(f"grep -n 'function {func}\\|^export.*function {func}' /root/jh/functions/groupResponder.js 2>/dev/null | head -1")
    print(f"{func}: {out.strip()}")

client.close()