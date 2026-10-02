"""
Migração: imagens embutidas nos certificados antigos -> certImagens/<hash>

Certificados antigos carregam em empresa.<campo> (logoUrl, logo1, logo2, fundo,
assinaturaCert, assinaturaImg2, ...) a imagem inteira em base64. São ~150 MB
de cópias da mesma meia dúzia de imagens. Este script:

  1. guarda cada imagem distinta UMA vez em  certImagens/<sha1>
  2. em cada certificado troca a imagem por  empresa/imgRefs/<campo> = <sha1>
  3. marca _migracoes/certImagens
  4. confere: cada certificado, remontado com as imagens, fica IGUAL ao backup

O certificados.html (versão nova) remonta as imagens antes de imprimir.
SÓ RODE DEPOIS DE PUBLICAR A VERSÃO NOVA DO certificados.html.

Uso:
  python migrar-imagens-certificados.py            (simulação, não grava nada)
  python migrar-imagens-certificados.py --executar (grava no banco)

Fonte: backup-firebase-2026-10-01/certificadosGerados.json (para desfazer,
basta regravar os campos do backup).
"""
import hashlib
import json
import sys
import time
import urllib.request

BASE = "https://cadastr-produtos-clevir-default-rtdb.firebaseio.com"
BACKUP = "backup-firebase-2026-10-01/certificadosGerados.json"
MIN_TAM = 1000  # só strings grandes começando com data: são imagens
LOTE = 40


def req(metodo, caminho, corpo=None, query=""):
    url = f"{BASE}/{caminho}.json{query}"
    dados = None if corpo is None else json.dumps(corpo).encode("utf-8")
    r = urllib.request.Request(url, data=dados, method=metodo,
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=300) as resp:
        return json.loads(resp.read() or b"null")


def eh_imagem(v):
    return isinstance(v, str) and len(v) > MIN_TAM and v.startswith("data:")


def sha(v):
    return hashlib.sha1(v.encode("utf-8")).hexdigest()


def main():
    executar = "--executar" in sys.argv
    certs = json.load(open(BACKUP, encoding="utf-8"))
    vivos = set((req("GET", "certificadosGerados", query="?shallow=true") or {}).keys())
    print(f"backup: {len(certs)} certificados | no banco agora: {len(vivos)}")

    imagens = {}        # sha -> conteúdo
    patch_certs = {}    # caminho -> valor
    alvo = 0
    bytes_tirados = 0
    for k, c in certs.items():
        if k not in vivos:
            continue  # excluído depois do backup: não recria
        emp = (c or {}).get("empresa")
        if not isinstance(emp, dict):
            continue
        mexeu = False
        for campo, v in emp.items():
            if campo == "imgRefs" or not eh_imagem(v):
                continue
            h = sha(v)
            imagens[h] = v
            patch_certs[f"certificadosGerados/{k}/empresa/{campo}"] = None
            patch_certs[f"certificadosGerados/{k}/empresa/imgRefs/{campo}"] = h
            bytes_tirados += len(v)
            mexeu = True
        if mexeu:
            alvo += 1

    tam_imgs = sum(len(v) for v in imagens.values())
    print(f"certificados a migrar: {alvo}")
    print(f"imagens distintas: {len(imagens)} ({tam_imgs/1e6:.1f} MB, gravadas uma vez)")
    print(f"removido dos certificados: {bytes_tirados/1e6:.1f} MB")
    if not executar:
        print("\nSIMULAÇÃO: nada foi gravado. Rode com --executar para aplicar.")
        return

    # 1) imagens primeiro: um certificado nunca aponta para hash inexistente
    for h, v in imagens.items():
        req("PUT", f"certImagens/{h}", v)
        volta = req("GET", f"certImagens/{h}")
        if volta != v:
            raise SystemExit(f"ERRO: certImagens/{h} não confere após gravar. Parei.")
    print(f"{len(imagens)} imagem(ns) gravada(s) e conferida(s).")

    # 2) certificados, em lotes (cada lote é atômico no servidor)
    por_cert = {}
    for p, v in patch_certs.items():
        por_cert.setdefault(p.split("/")[1], {})[p] = v
    ids = list(por_cert)
    for i in range(0, len(ids), LOTE):
        lote = {}
        for k in ids[i:i + LOTE]:
            lote.update(por_cert[k])
        req("PATCH", "", lote)
        print(f"  certificados {min(i + LOTE, len(ids))}/{len(ids)}")

    # 3) marca a migração (o certificados.html usa para descartar cache pesado)
    req("PUT", "_migracoes/certImagens", int(time.time() * 1000))

    # 4) conferência completa
    novo = req("GET", "certificadosGerados") or {}
    print(f"nó certificadosGerados agora: {len(json.dumps(novo))/1e6:.1f} MB")
    cache = {}
    erros = 0
    for k in ids:
        c = novo.get(k) or {}
        emp = dict(c.get("empresa") or {})
        refs = emp.pop("imgRefs", {}) or {}
        for campo, h in refs.items():
            if h not in cache:
                cache[h] = req("GET", f"certImagens/{h}")
            emp[campo] = cache[h]
        original = certs[k].get("empresa") or {}
        if emp != original:
            erros += 1
            print("  DIVERGE:", k)
    print("CONFERÊNCIA OK: todos idênticos ao backup." if not erros
          else f"ATENÇÃO: {erros} certificado(s) divergentes (restaure pelo backup).")


if __name__ == "__main__":
    main()
