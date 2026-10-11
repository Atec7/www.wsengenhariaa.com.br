"""
Alinha o vencimento de TODOS os certificados já emitidos à validade ATUAL do
curso (a regra que a tela de cursos promete: mudou a validade, todos os
emitidos acompanham).

Corrige três situações encontradas em 11/10/2026:
  - certificados gerados com a validade antiga do curso (aparelhos com cache
    velho, antes da correção de 01/10);
  - certificados emitidos quando o curso "não vencia" e que nunca receberam
    vencimento depois que o curso passou a ter validade;
  - vencimentos com 1 dia a mais (erro antigo de fuso horário).

Também ajusta 'validade'/'expiracao' das linhas de certificado do histórico
ligadas a esses certificados, e anota tudo em '_mudancas' para as telas
abertas receberem na hora.

Uso:
  python corrigir-vencimentos-certificados.py            (simulação)
  python corrigir-vencimentos-certificados.py --executar (grava; faz backup antes)
"""
import calendar
import datetime
import json
import re
import sys
import urllib.request

BASE = "https://cadastr-produtos-clevir-default-rtdb.firebaseio.com"


def req(metodo, caminho, corpo=None):
    dados = None if corpo is None else json.dumps(corpo).encode("utf-8")
    r = urllib.request.Request(f"{BASE}/{caminho}.json", data=dados, method=metodo,
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=300) as resp:
        return json.loads(resp.read() or b"null")


def calc_expiracao(data_fim, validade):
    """Mesma regra do certificados.html (calcExpiracao)."""
    if not validade or validade == "none":
        return None
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", str(data_fim or "").strip())
    if not m:
        return "?"
    ano = int(m.group(1)) + int(validade)
    mes = int(m.group(2))
    dia = min(int(m.group(3)), calendar.monthrange(ano, mes)[1])
    return "%04d-%02d-%02d" % (ano, mes, dia)


def main():
    executar = "--executar" in sys.argv
    cursos = req("GET", "cursos") or {}
    certs = req("GET", "certificadosGerados") or {}
    hist = req("GET", "historico") or {}

    up = {}
    mud_c, mud_h = set(), set()
    motivo = {"validade antiga": 0, "sem vencimento": 0, "1 dia a mais": 0, "outro": 0}
    sem_data = 0
    por_curso = {}
    for k, c in certs.items():
        cid = (c.get("curso") or {}).get("id")
        cu = cursos.get(cid)
        if not cu:
            continue
        v = cu.get("validade") or "none"
        esperado = calc_expiracao(c.get("dataFim"), v)
        if esperado == "?":
            sem_data += 1
            continue
        atual_v = (c.get("curso") or {}).get("validade")
        atual_e = c.get("expiracao") or None
        if atual_e == esperado and atual_v == v:
            continue
        if atual_v and atual_v != v:
            motivo["validade antiga"] += 1
        elif atual_e is None and esperado:
            motivo["sem vencimento"] += 1
        elif atual_e and esperado and atual_e > esperado:
            motivo["1 dia a mais" if (datetime.date.fromisoformat(atual_e) - datetime.date.fromisoformat(esperado)).days == 1 else "outro"] += 1
        else:
            motivo["outro"] += 1
        up[f"certificadosGerados/{k}/curso/validade"] = v
        up[f"certificadosGerados/{k}/expiracao"] = esperado
        mud_c.add(k)
        por_curso[cu.get("nome", cid)] = por_curso.get(cu.get("nome", cid), 0) + 1

    # histórico: só linhas ligadas a certificados (certIds) ou com dataFim
    linhas_sem_base = 0
    for k, h in hist.items():
        if not isinstance(h, dict) or h.get("tipo") != "certificado":
            continue
        cu = cursos.get(h.get("certificadoCursoId"))
        if not cu:
            continue
        v = cu.get("validade") or "none"
        data_fim = h.get("dataFim")
        if not data_fim:
            for cid in h.get("certIds") or []:
                if certs.get(cid, {}).get("dataFim"):
                    data_fim = certs[cid]["dataFim"]
                    break
        if not data_fim:
            linhas_sem_base += 1
            continue
        esperado = calc_expiracao(data_fim, v)
        if esperado == "?":
            linhas_sem_base += 1
            continue
        if h.get("validade") == v and (h.get("expiracao") or None) == esperado:
            continue
        up[f"historico/{k}/validade"] = v
        up[f"historico/{k}/expiracao"] = esperado
        mud_h.add(k)

    print(f"certificados a corrigir: {len(mud_c)} de {len(certs)}")
    for m, n in motivo.items():
        if n:
            print(f"   {m}: {n}")
    for nome, n in sorted(por_curso.items(), key=lambda x: -x[1])[:10]:
        print(f"   - {nome[:60]}: {n}")
    print(f"linhas do histórico a corrigir: {len(mud_h)} (sem data de fim identificável, ficam como estão: {linhas_sem_base})")
    if sem_data:
        print(f"certificados sem data de fim válida (ficam como estão): {sem_data}")
    if not executar:
        print("\nSIMULAÇÃO: nada foi gravado. Rode com --executar para aplicar.")
        return

    carimbo = datetime.datetime.now().strftime("%Y-%m-%dT%H-%M")
    nome = f"backup-firebase-2026-10-01/vencimentos-antes-{carimbo}.json"
    json.dump({"certificadosGerados": {k: certs[k] for k in mud_c}, "historico": {k: hist[k] for k in mud_h}},
              open(nome, "w", encoding="utf-8"), ensure_ascii=False)
    print("backup:", nome)

    chaves = list(up)
    for i in range(0, len(chaves), 400):
        req("PATCH", "", {k: up[k] for k in chaves[i:i + 400]})
    for no, ks in (("certificadosGerados", sorted(mud_c)), ("historico", sorted(mud_h))):
        for i in range(0, len(ks), 400):
            req("POST", f"_mudancas/{no}", {"k": ks[i:i + 400], "t": {".sv": "timestamp"}})
        if ks:
            req("PUT", f"_meta/{no}", {".sv": "timestamp"})

    # conferência
    c2 = req("GET", "certificadosGerados") or {}
    erros = 0
    for k in mud_c:
        if (c2.get(k) or {}).get("expiracao") != up[f"certificadosGerados/{k}/expiracao"]:
            erros += 1
    print("CONFERÊNCIA OK." if not erros else f"ATENÇÃO: {erros} certificado(s) não conferem.")


if __name__ == "__main__":
    main()
