#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Transcritor de Voz em Tempo Real (Português) - 100% offline

Recursos:
  - Grava do microfone e escreve o texto enquanto você fala (texto parcial em cinza)
  - Botões: Gravar / Parar, Copiar, Nova gravação, Salvar .txt
  - Escolha do microfone e do modelo (rápido ou preciso)
  - Medidor de volume do microfone
  - Baixa o modelo de idioma automaticamente na primeira vez

Instalação:
    pip install vosk sounddevice
    (Linux: sudo apt install python3-tk portaudio19-dev)

Uso:
    python transcritor_voz.py
"""

import json
import os
import queue
import threading
import tkinter as tk
import urllib.request
import zipfile
from array import array
from tkinter import filedialog, messagebox, ttk

try:
    import sounddevice as sd
    from vosk import KaldiRecognizer, Model, SetLogLevel

    SetLogLevel(-1)
except ImportError:
    raise SystemExit(
        "Faltam dependências. Instale com:\n\n    pip install vosk sounddevice\n"
    )

SAMPLE_RATE = 16000
BLOCK_SIZE = 4000  # ~0,25 s de áudio por bloco

MODELOS = {
    "Rápido (pequeno, ~31 MB)": (
        "vosk-model-small-pt-0.3",
        "https://alphacephei.com/vosk/models/vosk-model-small-pt-0.3.zip",
    ),
    "Preciso (grande, ~1,6 GB)": (
        "vosk-model-pt-fb-v0.1.1-20220516_2113",
        "https://alphacephei.com/vosk/models/vosk-model-pt-fb-v0.1.1-20220516_2113.zip",
    ),
}
PASTA_MODELOS = os.path.join(os.path.expanduser("~"), ".vosk_models")


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("Transcritor de Voz")
        root.geometry("760x560")
        root.minsize(560, 420)

        self.audio_q: "queue.Queue[bytes]" = queue.Queue()
        self.ui_q: "queue.Queue[tuple]" = queue.Queue()
        self.modelos_carregados = {}
        self.gravando = False
        self.parar_evt = threading.Event()
        self.stream = None
        self.worker = None
        self.ocupado = False  # baixando/carregando modelo

        self._montar_ui()
        self._listar_microfones()
        self.root.after(50, self._processar_fila_ui)
        root.protocol("WM_DELETE_WINDOW", self._fechar)

    # ------------------------------------------------------------------ UI
    def _montar_ui(self):
        top = ttk.Frame(self.root, padding=(12, 12, 12, 4))
        top.pack(fill="x")

        ttk.Label(top, text="Microfone:").grid(row=0, column=0, sticky="w")
        self.cmb_mic = ttk.Combobox(top, state="readonly", width=42)
        self.cmb_mic.grid(row=0, column=1, sticky="ew", padx=(6, 12))

        ttk.Label(top, text="Modelo:").grid(row=0, column=2, sticky="w")
        self.cmb_modelo = ttk.Combobox(
            top, state="readonly", width=26, values=list(MODELOS.keys())
        )
        self.cmb_modelo.current(0)
        self.cmb_modelo.grid(row=0, column=3, sticky="ew", padx=(6, 0))
        top.columnconfigure(1, weight=1)

        botoes = ttk.Frame(self.root, padding=(12, 8))
        botoes.pack(fill="x")

        self.btn_gravar = ttk.Button(
            botoes, text="🎙  Gravar", command=self.alternar_gravacao, width=14
        )
        self.btn_gravar.pack(side="left")

        self.btn_copiar = ttk.Button(
            botoes, text="📋 Copiar", command=self.copiar, width=12
        )
        self.btn_copiar.pack(side="left", padx=(8, 0))

        self.btn_novo = ttk.Button(
            botoes, text="🆕 Nova gravação", command=self.nova_gravacao
        )
        self.btn_novo.pack(side="left", padx=(8, 0))

        self.btn_salvar = ttk.Button(
            botoes, text="💾 Salvar .txt", command=self.salvar
        )
        self.btn_salvar.pack(side="left", padx=(8, 0))

        self.nivel = ttk.Progressbar(botoes, maximum=100, length=110)
        self.nivel.pack(side="right")
        ttk.Label(botoes, text="Volume:").pack(side="right", padx=(0, 6))

        frame_txt = ttk.Frame(self.root, padding=(12, 0, 12, 4))
        frame_txt.pack(fill="both", expand=True)

        self.txt = tk.Text(
            frame_txt, wrap="word", font=("Segoe UI", 13), undo=True,
            padx=10, pady=10, relief="solid", borderwidth=1,
        )
        sb = ttk.Scrollbar(frame_txt, command=self.txt.yview)
        self.txt.configure(yscrollcommand=sb.set)
        self.txt.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")

        self.txt.tag_configure("parcial", foreground="#8a8a8a")
        self.txt.mark_set("parcial_ini", "end-1c")
        self.txt.mark_gravity("parcial_ini", "left")

        self.status = tk.StringVar(value="Pronto. Clique em Gravar e comece a falar.")
        ttk.Label(
            self.root, textvariable=self.status, anchor="w", padding=(12, 4, 12, 10)
        ).pack(fill="x")

    def _listar_microfones(self):
        self.dispositivos = []
        nomes = []
        try:
            padrao = sd.default.device[0]
            for i, d in enumerate(sd.query_devices()):
                if d["max_input_channels"] > 0:
                    self.dispositivos.append(i)
                    nomes.append(f"{i}: {d['name']}")
            if not nomes:
                raise RuntimeError("nenhum microfone encontrado")
            idx = self.dispositivos.index(padrao) if padrao in self.dispositivos else 0
            self.cmb_mic["values"] = nomes
            self.cmb_mic.current(idx)
        except Exception as e:
            self.cmb_mic["values"] = ["(nenhum microfone)"]
            self.cmb_mic.current(0)
            self.status.set(f"Aviso: {e}")

    # ----------------------------------------------------- modelo (download)
    def _caminho_modelo(self, nome_pasta):
        return os.path.join(PASTA_MODELOS, nome_pasta)

    def _garantir_modelo(self, chave):
        """Roda em thread: baixa (se preciso) e carrega o modelo."""
        if chave in self.modelos_carregados:
            return self.modelos_carregados[chave]

        pasta, url = MODELOS[chave]
        destino = self._caminho_modelo(pasta)

        if not os.path.isdir(destino):
            os.makedirs(PASTA_MODELOS, exist_ok=True)
            zip_path = destino + ".zip"

            def progresso(blocos, tam_bloco, total):
                if total > 0:
                    pct = min(100, blocos * tam_bloco * 100 // total)
                    self.ui_q.put(("status", f"Baixando modelo... {pct}%"))

            self.ui_q.put(("status", "Baixando modelo (só na primeira vez)..."))
            urllib.request.urlretrieve(url, zip_path, progresso)

            self.ui_q.put(("status", "Extraindo modelo..."))
            with zipfile.ZipFile(zip_path) as z:
                z.extractall(PASTA_MODELOS)
            os.remove(zip_path)

        self.ui_q.put(("status", "Carregando modelo na memória..."))
        modelo = Model(destino)
        self.modelos_carregados[chave] = modelo
        return modelo

    # ------------------------------------------------------------ gravação
    def alternar_gravacao(self):
        if self.ocupado:
            return
        if self.gravando:
            self.parar()
        else:
            self.iniciar()

    def iniciar(self):
        if not self.dispositivos:
            messagebox.showerror("Erro", "Nenhum microfone disponível.")
            return

        self.ocupado = True
        self.btn_gravar.config(state="disabled")
        self.cmb_modelo.config(state="disabled")
        self.cmb_mic.config(state="disabled")

        chave = self.cmb_modelo.get()
        dev = self.dispositivos[self.cmb_mic.current()]

        def preparar():
            try:
                modelo = self._garantir_modelo(chave)
                self.ui_q.put(("pronto_para_gravar", (modelo, dev)))
            except Exception as e:
                self.ui_q.put(("erro", f"Falha ao preparar o modelo: {e}"))

        threading.Thread(target=preparar, daemon=True).start()

    def _comecar_captura(self, modelo, dev):
        # limpa restos de áudio antigo
        while not self.audio_q.empty():
            try:
                self.audio_q.get_nowait()
            except queue.Empty:
                break

        try:
            self.stream = sd.RawInputStream(
                samplerate=SAMPLE_RATE,
                blocksize=BLOCK_SIZE,
                device=dev,
                dtype="int16",
                channels=1,
                callback=self._callback_audio,
            )
            self.stream.start()
        except Exception as e:
            self._erro(f"Não foi possível abrir o microfone: {e}")
            return

        self.parar_evt.clear()
        self.worker = threading.Thread(
            target=self._loop_reconhecimento, args=(modelo,), daemon=True
        )
        self.worker.start()

        # se já há texto, continua a partir do fim
        self.txt.mark_set("parcial_ini", "end-1c")
        self.gravando = True
        self.ocupado = False
        self.btn_gravar.config(text="⏹  Parar", state="normal")
        self.status.set("🔴 Ouvindo... fale agora.")

    def _callback_audio(self, indata, frames, time_info, status):
        dados = bytes(indata)
        self.audio_q.put(dados)
        # nível de volume (amostragem rápida)
        amostras = array("h", dados)
        pico = max((abs(a) for a in amostras[::8]), default=0)
        self.ui_q.put(("nivel", min(100, pico * 100 // 12000)))

    def _loop_reconhecimento(self, modelo):
        rec = KaldiRecognizer(modelo, SAMPLE_RATE)
        rec.SetWords(False)
        ultimo_parcial = ""

        while True:
            try:
                dados = self.audio_q.get(timeout=0.2)
            except queue.Empty:
                if self.parar_evt.is_set():
                    break
                continue

            if rec.AcceptWaveform(dados):
                texto = json.loads(rec.Result()).get("text", "").strip()
                ultimo_parcial = ""
                self.ui_q.put(("final", texto))
            else:
                parcial = json.loads(rec.PartialResult()).get("partial", "")
                if parcial != ultimo_parcial:
                    ultimo_parcial = parcial
                    self.ui_q.put(("parcial", parcial))

            if self.parar_evt.is_set() and self.audio_q.empty():
                break

        texto = json.loads(rec.FinalResult()).get("text", "").strip()
        self.ui_q.put(("final", texto))
        self.ui_q.put(("terminou", None))

    def parar(self):
        self.gravando = False
        self.btn_gravar.config(state="disabled")
        self.status.set("Finalizando...")
        try:
            if self.stream:
                self.stream.stop()
                self.stream.close()
        except Exception:
            pass
        self.stream = None
        self.parar_evt.set()

    # ----------------------------------------------------- atualizar texto
    def _texto_parcial(self, parcial):
        self.txt.delete("parcial_ini", "end-1c")
        if parcial:
            prefixo = self._prefixo_espaco()
            self.txt.insert("parcial_ini", prefixo + parcial, "parcial")
            self.txt.see("end")

    def _texto_final(self, texto):
        self.txt.delete("parcial_ini", "end-1c")
        if texto:
            texto = self._capitalizar_se_preciso(texto)
            self.txt.insert("parcial_ini", self._prefixo_espaco() + texto)
        self.txt.mark_set("parcial_ini", "end-1c")
        self.txt.see("end")

    def _conteudo_antes(self):
        return self.txt.get("1.0", "parcial_ini")

    def _prefixo_espaco(self):
        antes = self._conteudo_antes()
        if not antes or antes[-1].isspace():
            return ""
        return " "

    def _capitalizar_se_preciso(self, texto):
        antes = self._conteudo_antes().rstrip()
        if not antes or antes[-1] in ".!?":
            return texto[0].upper() + texto[1:]
        return texto

    # ------------------------------------------------ fila de eventos (UI)
    def _processar_fila_ui(self):
        try:
            while True:
                tipo, valor = self.ui_q.get_nowait()
                if tipo == "parcial":
                    if self.gravando or self.parar_evt.is_set():
                        self._texto_parcial(valor)
                elif tipo == "final":
                    self._texto_final(valor)
                elif tipo == "nivel":
                    self.nivel["value"] = valor
                elif tipo == "status":
                    self.status.set(valor)
                elif tipo == "pronto_para_gravar":
                    self._comecar_captura(*valor)
                elif tipo == "terminou":
                    self.nivel["value"] = 0
                    self.btn_gravar.config(text="🎙  Gravar", state="normal")
                    self.cmb_modelo.config(state="readonly")
                    self.cmb_mic.config(state="readonly")
                    self.status.set(
                        "Parado. Copie o texto, salve, ou grave mais (continua do fim)."
                    )
                elif tipo == "erro":
                    self._erro(valor)
        except queue.Empty:
            pass
        self.root.after(40, self._processar_fila_ui)

    def _erro(self, msg):
        self.gravando = False
        self.ocupado = False
        self.btn_gravar.config(text="🎙  Gravar", state="normal")
        self.cmb_modelo.config(state="readonly")
        self.cmb_mic.config(state="readonly")
        self.status.set("Erro.")
        messagebox.showerror("Erro", msg)

    # --------------------------------------------------------------- ações
    def _texto_completo(self):
        return self.txt.get("1.0", "end-1c").strip()

    def copiar(self):
        texto = self._texto_completo()
        if not texto:
            self.status.set("Nada para copiar ainda.")
            return
        self.root.clipboard_clear()
        self.root.clipboard_append(texto)
        self.root.update()
        self.btn_copiar.config(text="✅ Copiado!")
        self.root.after(1500, lambda: self.btn_copiar.config(text="📋 Copiar"))
        self.status.set("Texto copiado para a área de transferência.")

    def nova_gravacao(self):
        if self.gravando:
            self.parar()
            # espera a thread terminar antes de limpar
            self.root.after(500, self._limpar)
        else:
            self._limpar()

    def _limpar(self):
        self.txt.delete("1.0", "end")
        self.txt.mark_set("parcial_ini", "1.0")
        self.status.set("Texto limpo. Clique em Gravar para começar de novo.")

    def salvar(self):
        texto = self._texto_completo()
        if not texto:
            self.status.set("Nada para salvar ainda.")
            return
        caminho = filedialog.asksaveasfilename(
            defaultextension=".txt",
            filetypes=[("Texto", "*.txt")],
            initialfile="transcricao.txt",
        )
        if caminho:
            with open(caminho, "w", encoding="utf-8") as f:
                f.write(texto)
            self.status.set(f"Salvo em {caminho}")

    def _fechar(self):
        try:
            self.parar_evt.set()
            if self.stream:
                self.stream.stop()
                self.stream.close()
        except Exception:
            pass
        self.root.destroy()


def main():
    root = tk.Tk()
    try:
        ttk.Style().theme_use("clam" if os.name != "nt" else "vista")
    except tk.TclError:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()