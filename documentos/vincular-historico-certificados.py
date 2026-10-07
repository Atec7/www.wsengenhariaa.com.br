"""
Vínculo histórico <-> certificados para os registros ANTIGOS.

Gerações novas já gravam a ligação (certificado.histKey e linha.certIds).
As antigas não têm, e por isso excluir no index.html não excluía o certificado
no certificados.html (e vice-versa). Este script grava essa ligação, só onde a
correspondência é segura:

  - mesmo curso, mesma empresa, aluno presente na linha;
  - a linha foi registrada até 30 min depois do certificado (o horário vem do
    'ts' ou, nos antigos, do próprio id do Firebase, que embute o horário);
  - fica com a linha mais próxima; por linha, um certificado por aluno (o mais
    recente). Na dúvida, não liga: o registro só não é excluído em cascata.

Só ACRESCENTA campos (histKey nos certificados, certIds nas linhas); não apaga
nem altera nada que já existe. Pode rodar mais de uma vez.

Uso:
  python vincular-historico-certificados.py            (simulação)
  python vincular-historico-certificados.py --executar (grava)
"""
import json
import sys
import urllib.request
from collections import defaultdict

BASE = "https://cadastr-produtos-clevir-default-rtdb.firebaseio.com"
JANELA_MS = 30 * 60 * 1000
FOLGA_MS = 2000
PC = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz'


def req(metodo, caminho, corpo=None):
    dados = None if corpo is None else json.dumps(corpo).encode("utf-8")
    r = urllib.request.Request(f"{BASE}/{caminho}.json", data=dados, method=metodo,
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=300) as resp:
        return json.loads(resp.read() or b"null")


def tempo_da_chave(k):
    t = 0
    for ch in k[:8]:
        t = t * 64 + PC.index(ch)
    return t


def num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def main():
    executar = "--executar" in sys.argv
    hist = req("GET", "historico") or {}
    certs = req("GET", "certificadosGerados") or {}

    linhas = {k: h for k, h in hist.items()
              if isinstance(h, dict) and h.get("tipo") == "certificado" and h.get("certificadoCursoId")}
    print(f"linhas de certificado: {len(linhas)} | certificados: {len(certs)}")

    # índice: (curso, empresa, aluno) -> [(tempo da linha, chave)]
    idx = defaultdict(list)
    for k, h in linhas.items():
        if h.get("certIds"):
            continue  # já ligada (geração nova)
        for a in h.get("funcionarioIds") or []:
            idx[(h["certificadoCursoId"], h.get("empresaId"), a)].append((tempo_da_chave(k), k))
    for v in idx.values():
        v.sort()

    # cada certificado -> linha mais próxima dentro da janela
    escolha = defaultdict(dict)   # linha -> aluno -> (tempo cert, id cert)
    for ck, c in certs.items():
        if not isinstance(c, dict) or c.get("histKey"):
            continue
        t = c["ts"] if num(c.get("ts")) else tempo_da_chave(ck)
        curso = (c.get("curso") or {}).get("id")
        aluno = (c.get("aluno") or {}).get("id")
        emp = c.get("empresaId") or (c.get("empresa") or {}).get("id")
        cand = [x for x in idx.get((curso, emp, aluno), []) if t - FOLGA_MS <= x[0] <= t + JANELA_MS]
        if not cand:
            continue
        lk = cand[0][1]
        atual = escolha[lk].get(aluno)
        if atual is None or t > atual[0]:
            escolha[lk][aluno] = (t, ck)

    up = {}
    n_certs = 0
    for lk, por_aluno in escolha.items():
        ids = [ck for _, ck in sorted(por_aluno.values())]
        up[f"historico/{lk}/certIds"] = ids
        for ck in ids:
            up[f"certificadosGerados/{ck}/histKey"] = lk
            n_certs += 1

    sem = sum(1 for k, h in linhas.items() if not h.get("certIds") and k not in escolha)
    print(f"linhas que serão ligadas: {len(escolha)} | certificados ligados: {n_certs}")
    print(f"linhas antigas sem certificado identificável (ficam como estão): {sem}")
    print(f"certificados sem linha segura (ficam como estão): "
          f"{sum(1 for c in certs.values() if isinstance(c, dict) and not c.get('histKey')) - n_certs}")
    if not executar:
        print("\nSIMULAÇÃO: nada foi gravado. Rode com --executar para aplicar.")
        return

    chaves = list(up)
    for i in range(0, len(chaves), 400):
        req("PATCH", "", {k: up[k] for k in chaves[i:i + 400]})
    # carimbos: as telas abertas percebem a mudança
    req("PUT", "_meta/historico", {".sv": "timestamp"})
    req("PUT", "_meta/certificadosGerados", {".sv": "timestamp"})

    # conferência
    h2 = req("GET", "historico") or {}
    c2 = req("GET", "certificadosGerados") or {}
    erros = 0
    for lk in escolha:
        for ck in h2.get(lk, {}).get("certIds") or []:
            if (c2.get(ck) or {}).get("histKey") != lk:
                erros += 1
    print("CONFERÊNCIA OK." if not erros else f"ATENÇÃO: {erros} vínculo(s) não conferem.")


if __name__ == "__main__":
    main()
