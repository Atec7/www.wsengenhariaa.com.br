"""
Corrige as relações empresa > obra/contrato > cidade > filial nos dados.

  1. Obras/cidades/filiais usadas pelos colaboradores de uma empresa passam a
     constar na lista da empresa (empresa.obras / .cidades / .filiais, em ids).
  2. O campo antigo de cidade da empresa (texto, às vezes o NOME) é convertido
     para id e entra na lista.
  3. O espelho em 'alunos' recebe a empresa/obra/cidade/filial do cadastro de
     colaboradores quando estiver diferente ou vazio.
  4. Só RELATA (não altera) o que precisa de decisão: colaborador com empresa
     inexistente e referências que não existem no cadastro.

Uso:
  python corrigir-relacoes.py            (simulação)
  python corrigir-relacoes.py --executar (grava; faz backup antes)
"""
import datetime
import json
import sys
import urllib.request

BASE = "https://cadastr-produtos-clevir-default-rtdb.firebaseio.com"
SING = {"obras": "obra", "cidades": "cidade", "filiais": "filial"}
CAMPO = {"obras": "obraId", "cidades": "cidadeId", "filiais": "filialId"}


def req(metodo, caminho, corpo=None):
    dados = None if corpo is None else json.dumps(corpo).encode("utf-8")
    r = urllib.request.Request(f"{BASE}/{caminho}.json", data=dados, method=metodo,
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=300) as resp:
        return json.loads(resp.read() or b"null")


def main():
    executar = "--executar" in sys.argv
    E = req("GET", "empresas") or {}
    CAT = {c: req("GET", c) or {} for c in ("obras", "cidades", "filiais")}
    F = req("GET", "funcionarios") or {}
    A = req("GET", "alunos") or {}

    def resolve(col, x):
        t = str(x or "").strip()
        if not t:
            return None
        if t in CAT[col]:
            return t
        for k, c in CAT[col].items():
            if str((c or {}).get("nome") or "").strip() == t:
                return k
        return None

    up = {}
    rel = {"vinculos_novos": 0, "legado_convertido": 0, "invalidas": [], "espelho": 0, "sem_empresa": []}
    for eid, e in E.items():
        if not isinstance(e, dict):
            continue
        for col in ("obras", "cidades", "filiais"):
            atual = []
            raw = e.get(col)
            itens = raw if isinstance(raw, list) else ([x for x in str(raw).split(",")] if isinstance(raw, str) and raw.strip() else [])
            for x in itens:
                r = resolve(col, x)
                if r and r not in atual:
                    atual.append(r)
                elif not r:
                    rel["invalidas"].append(f"{e.get('nome')}: {col} '{x}' não existe")
            leg = e.get(SING[col])
            if isinstance(leg, str) and leg.strip():
                r = resolve(col, leg)
                if r and r not in atual:
                    atual.append(r)
                    rel["legado_convertido"] += 1
                elif not r:
                    rel["invalidas"].append(f"{e.get('nome')}: {SING[col]} '{leg}' não existe")
            novos = []
            for f in F.values():
                if isinstance(f, dict) and f.get("empresaId") == eid:
                    v = f.get(CAMPO[col])
                    if v and v in CAT[col] and v not in atual and v not in novos:
                        novos.append(v)
            final = atual + novos
            orig = raw if isinstance(raw, list) else None
            if final and final != orig:
                up[f"empresas/{eid}/{col}"] = final
                rel["vinculos_novos"] += len(novos)

    for k, f in F.items():
        if not isinstance(f, dict):
            continue
        if f.get("empresaId") and f["empresaId"] not in E:
            rel["sem_empresa"].append(f"{f.get('nome')} (id {k})")
        a = A.get(k)
        if not isinstance(a, dict):
            continue
        for fc, ac in (("empresaId", "empresaVinculoId"), ("obraId", "obraId"), ("cidadeId", "cidadeId"), ("filialId", "filialId")):
            fv, av = f.get(fc) or "", a.get(ac) or ""
            if fv and fv != av:
                up[f"alunos/{k}/{ac}"] = fv
                rel["espelho"] += 1

    print(f"vínculos novos obra/cidade/filial nas empresas: {rel['vinculos_novos']}")
    print(f"campos antigos de cidade convertidos para id: {rel['legado_convertido']}")
    print(f"campos do espelho 'alunos' alinhados: {rel['espelho']}")
    print(f"empresas alteradas: {len({k.split('/')[1] for k in up if k.startswith('empresas/')})}")
    for x in rel["invalidas"]:
        print("  [ver] referência inválida —", x)
    for x in rel["sem_empresa"]:
        print("  [ver] colaborador com empresa inexistente —", x)
    if not up:
        print("Nada a fazer.")
        return
    if not executar:
        print("\nSIMULAÇÃO: nada foi gravado. Rode com --executar para aplicar.")
        return
    nome = f"backup-firebase-2026-10-01/relacoes-antes-{datetime.datetime.now():%Y-%m-%dT%H-%M}.json"
    emp_alt = {k.split('/')[1] for k in up if k.startswith('empresas/')}
    al_alt = {k.split('/')[1] for k in up if k.startswith('alunos/')}
    json.dump({"empresas": {k: {c: E[k].get(c) for c in ("obras", "cidades", "filiais", "obra", "cidade", "filial")} for k in emp_alt},
               "alunos": {k: A[k] for k in al_alt}}, open(nome, "w", encoding="utf-8"), ensure_ascii=False)
    print("backup:", nome)
    req("PATCH", "", up)
    for no in ("empresas", "alunos"):
        req("PUT", f"_meta/{no}", {".sv": "timestamp"})
    E2 = req("GET", "empresas") or {}
    erros = [k for k, v in up.items() if k.startswith("empresas/") and E2.get(k.split('/')[1], {}).get(k.split('/')[2]) != v]
    print("CONFERÊNCIA OK." if not erros else f"ATENÇÃO: {len(erros)} campo(s) não conferem.")


if __name__ == "__main__":
    main()
