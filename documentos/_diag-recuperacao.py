import json, urllib.request, datetime

BASE = "https://cadastr-produtos-clevir-default-rtdb.firebaseio.com"

def get(path):
    with urllib.request.urlopen(f"{BASE}/{path}.json", timeout=180) as r:
        return json.load(r)

lix = get("_lixeira/funcionarios") or {}
print("lotes na lixeira:", len(lix))
for k, lote in lix.items():
    lote = lote or {}
    dt = "?"
    try:
        dt = datetime.datetime.fromtimestamp(int(k) / 1000).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        pass
    print(f"  lote {k}  ({dt})  -> {len(lote)} registro(s)")

func = get("funcionarios") or {}
alu = get("alunos") or {}
print("funcionarios atuais:", len(func))
print("alunos atuais:", len(alu))

ids_lix = set()
for lote in lix.values():
    ids_lix |= set((lote or {}).keys())

print("ids unicos na lixeira:", len(ids_lix))
print("ids da lixa ainda presentes em funcionarios:", len(ids_lix & set(func.keys())))

amostra = []
for lote in lix.values():
    for i, r in (lote or {}).items():
        amostra.append((i, r))
        if len(amostra) >= 5:
            break
    if len(amostra) >= 5:
        break

print("\n--- amostra de registros na lixeira ---")
for i, r in amostra:
    campos = sorted(r.keys()) if isinstance(r, dict) else r
    print(f"id={i} campos={campos}")
    if isinstance(r, dict):
        print("   ", json.dumps(r, ensure_ascii=False)[:400])
