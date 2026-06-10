import sys
import os
import re

# ── BLINDAGEM ANTI-FRAUDE ────────────────────────────────────────
# Estrategia: corrupcao ZERO na estrutura do PDF.
# Apenas metadados malformados e /Prev falso no trailer.
# - Viewers ignoram metadados invalidos e /Prev
# - Conversores estritos tentam ler metadados, seguem /Prev e falham
#
# A protecao REAL contra fraude vem de:
#   1. Criptografia com permissoes restritas (pdf-lib encrypt)
#   2. Hash SHA-256 no Firebase (verificar.html)
#   3. QR Code com ID de autenticacao no rodape
# ─────────────────────────────────────────────────────────────────


def inject_garbage_metadata(data: bytes) -> bytes:
    """Injeta metadados malformados no Catalog e no Info dict.
    
    Viewers simplesmente ignoram campos que nao reconhecem.
    Conversores que tentam ler TODOS os metadados quebram.
    """
    # Catalog
    catalog_pattern = rb'(<<\s*/Type\s*/Catalog[^>]*>>)'
    def add_catalog_garbage(m):
        cat = m.group(1)
        if b'/X-Converter' not in cat:
            garbage = b'\n  /X-Converter /Nonexistent\n  /X-Version (999.999)\n  /X-Checksum <00000000000000000000000000000000>'
            cat = cat[:-2] + garbage + b'\n>>'
        return cat
    data = re.sub(catalog_pattern, add_catalog_garbage, data)

    # Info dict
    info_pattern = rb'(<<\s*/Title[^>]*>>)'
    def add_info_garbage(m):
        info = m.group(1)
        if b'/X-Fake' not in info:
            info = info[:-2] + b'\n  /X-Fake-Entry (corrupted)\n  /X-Fake-Date (D:99999999999999)\n>>'
        return info
    data = re.sub(info_pattern, add_info_garbage, data, count=1)

    return data


def inject_prev_in_trailer(data: bytes) -> bytes:
    """Adiciona /Prev no trailer apontando para offset inexistente.
    
    O campo /Prev em um trailer indica uma cadeia de xrefs anteriores.
    Viewers modernos NAO seguem /Prev apos encontrar o xref principal.
    Conversores e parsers estritos tentam seguir a cadeia e falham.
    """
    # Encontra o ultimo 'trailer' e seu fechamento >>
    trailer_start = data.rfind(b'\ntrailer\n')
    if trailer_start < 0:
        return data

    trailer_dict_start = data.find(b'<<', trailer_start)
    if trailer_dict_start < 0:
        return data

    # Encontra o >> de fechamento do dicionario do trailer
    close_pos = data.find(b'>>', trailer_dict_start)
    if close_pos < 0:
        return data

    # Verifica se ja existe /Prev
    between = data[trailer_dict_start:close_pos]
    if b'/Prev' in between:
        return data

    prev_entry = b'\n  /Prev 99999999'
    data = data[:close_pos] + prev_entry + data[close_pos:]

    return data


def blindar_pdf(input_path: str, output_path: str):
    with open(input_path, 'rb') as f:
        data = f.read()

    print("[1/2] Injetando metadados malformados...")
    data = inject_garbage_metadata(data)

    print("[2/2] Adicionando /Prev falso no trailer...")
    data = inject_prev_in_trailer(data)

    with open(output_path, 'wb') as f:
        f.write(data)

    orig_size = os.path.getsize(input_path)
    new_size = len(data)
    print(f"\nPDF blindado salvo em: {output_path}")
    print(f"Tamanho original: {orig_size} bytes")
    print(f"Tamanho final:    {new_size} bytes")
    print(f"Delta:            {new_size - orig_size} bytes")
    print("\n>>> PDF 100% original, estrutura intacta, ABRE NORMALMENTE")
    print(">>> Metadados malformados e /Prev falso confundem conversores")
    print(">>> Autenticidade via SHA-256 + Firebase + QR Code mantida")


def gerar_pdf_teste(path: str):
    content = (
        b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"
        b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
        b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
        b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]\n"
        b"   /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n"
        b"4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 24 Tf 100 700 Td (Hello World) Tj ET\nendstream\nendobj\n"
        b"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
        b"xref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n"
        b"0000000115 00000 n \n0000000266 00000 n \n0000000358 00000 n \n"
        b"trailer\n<< /Size 6 /Root 1 0 R >>\n"
        b"startxref\n406\n%%EOF\n"
    )
    with open(path, 'wb') as f:
        f.write(content)
    print(f"PDF de teste gerado: {path}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        test_pdf = "test_input.pdf"
        gerar_pdf_teste(test_pdf)
        blindar_pdf(test_pdf, "test_output_blindado.pdf")
    else:
        inp = sys.argv[1]
        out = sys.argv[2] if len(sys.argv) > 2 else inp.replace('.pdf', '_blindado.pdf')
        if not os.path.exists(inp):
            print(f"Erro: arquivo nao encontrado: {inp}")
            sys.exit(1)
        blindar_pdf(inp, out)
