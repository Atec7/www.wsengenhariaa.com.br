"""
Junta cadastros de EPI repetidos (mesmo estoque + mesmo nome + mesmo C.A.).

Regra pedida em 11/10/2026: fica um cadastro só, o MAIS NOVO, completado com
os dados que só os mais antigos tinham (ex.: unidade). Os saldos são somados.
Cargos e movimentações que apontavam para os cadastros antigos passam a
apontar para o que ficou; depois os antigos são apagados.

Uso:
  python unificar-epis-duplicados.py            (simulação)
  python unificar-epis-duplicados.py --executar (grava; faz backup antes)
"""
import datetime
import json
import sys
import urllib.request

BASE = "https://cadastr-produtos-clevir-default-rtdb.firebaseio.com"
CAMPOS_ESTOQUE = ("estoque",)


def req(metodo, caminho, corpo=None):
    dados = None if corpo is None else json.dumps(corpo).encode("utf-8")
    r = urllib.request.Request(f"{BASE}/{caminho}.json", data=dados, method=metodo,
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=300) as resp:
        return json.loads(resp.read() or b"null")


def norm(t):
    return " ".join(str(t or "").lower().split())


def vazio(v):
    return v is None or (isinstance(v, str) and not v.strip())


def estoque_de(m):
    if not m.get("empresaId"):
        return "_central"
    return m["empresaId"] + ("|" + m["obraId"] if m.get("obraId") else "")


def main():
    executar = "--executar" in sys.argv
    mats = req("GET", "materiais") or {}
    cargos = req("GET", "cargos") or {}
    movs = req("GET", "epiMov") or {}

    grupos = {}
    for k, m in mats.items():
        if not isinstance(m, dict):
            continue
        chave = (estoque_de(m), norm(m.get("nome")), norm(m.get("ca")))
        grupos.setdefault(chave, []).append(k)

    up = {}
    troca = {}          # id antigo -> id que fica
    relatorio = []
    for chave, ids in grupos.items():
        if len(ids) < 2:
            continue
        ids.sort()                       # id do push = ordem de criação
        fica = ids[-1]                   # o mais novo
        antigos = ids[:-1]
        novo = dict(mats[fica])
        preenchidos = []
        for a in antigos:                # do mais antigo para o mais novo
            for campo, val in mats[a].items():
                if campo in ("id",) + CAMPOS_ESTOQUE:
                    continue
                if vazio(novo.get(campo)) and not vazio(val):
                    novo[campo] = val
                    preenchidos.append(campo)
        novo["estoque"] = sum((mats[i].get("estoque") or 0) for i in ids)
        novo["id"] = fica
        up[f"materiais/{fica}"] = novo
        for a in antigos:
            up[f"materiais/{a}"] = None
            # de-para: telas e cargos com o id antigo continuam achando o item
            up[f"materiaisAlias/{a}"] = fica
            troca[a] = fica
        relatorio.append((mats[fica].get("nome"), chave[2], len(ids), fica, sorted(set(preenchidos)), novo["estoque"]))

    # cargos: a lista de EPIs passa a apontar para o cadastro que ficou
    cargos_alt = 0
    for ck, c in cargos.items():
        lista = c.get("epi") if isinstance(c, dict) else None
        if not isinstance(lista, list):
            continue
        mudou = False
        nova = []
        vistos = {}
        for it in lista:
            if not isinstance(it, dict):
                nova.append(it)
                continue
            it = dict(it)
            if it.get("id") in troca:
                it["id"] = troca[it["id"]]
                mudou = True
            if it.get("id") in vistos:   # o mesmo item duas vezes: fica a maior qtd
                j = vistos[it["id"]]
                nova[j]["qtd"] = max(nova[j].get("qtd") or 1, it.get("qtd") or 1)
                mudou = True
                continue
            vistos[it.get("id")] = len(nova)
            nova.append(it)
        if mudou:
            up[f"cargos/{ck}/epi"] = nova
            cargos_alt += 1

    movs_alt = [k for k, x in movs.items() if isinstance(x, dict) and x.get("materialId") in troca]
    for k in movs_alt:
        up[f"epiMov/{k}/materialId"] = troca[movs[k]["materialId"]]

    print(f"grupos de cadastros repetidos: {len(relatorio)}")
    for nome, ca, n, fica, campos, saldo in relatorio:
        print(f"  - {nome} (C.A. {ca}): {n} cadastros -> fica {fica}; completado com {campos or 'nada'}; saldo {saldo}")
    print(f"cargos atualizados: {cargos_alt} | movimentações atualizadas: {len(movs_alt)}")
    if not relatorio:
        print("Nada a fazer.")
        return
    if not executar:
        print("\nSIMULAÇÃO: nada foi gravado. Rode com --executar para aplicar.")
        return

    carimbo = datetime.datetime.now().strftime("%Y-%m-%dT%H-%M")
    nome = f"backup-firebase-2026-10-01/epis-antes-unificar-{carimbo}.json"
    json.dump({"materiais": mats, "cargos": cargos, "epiMov": {k: movs[k] for k in movs_alt}},
              open(nome, "w", encoding="utf-8"), ensure_ascii=False)
    print("backup:", nome)
    req("PATCH", "", up)
    for no in ("materiais", "cargos", "materiaisAlias"):
        req("PUT", f"_meta/{no}", {".sv": "timestamp"})
    if movs_alt:
        req("POST", "_mudancas/epiMov", {"k": movs_alt, "t": {".sv": "timestamp"}})
        req("PUT", "_meta/epiMov", {".sv": "timestamp"})

    m2 = req("GET", "materiais") or {}
    c2 = req("GET", "cargos") or {}
    erros = [a for a in troca if a in m2]
    refs = sum(1 for c in c2.values() if isinstance(c, dict) and isinstance(c.get("epi"), list)
               for it in c["epi"] if isinstance(it, dict) and it.get("id") in troca)
    print("CONFERÊNCIA OK." if not erros and not refs else f"ATENÇÃO: {len(erros)} antigo(s) ainda existem, {refs} referência(s) antigas em cargos.")


if __name__ == "__main__":
    main()
