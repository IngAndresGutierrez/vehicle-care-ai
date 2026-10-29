"""
Actualiza SOLO dos bloques de notas de la página 2 del resumen ejecutivo (decisiones del comité, 2026-10-29).

- Redacta (elimina de verdad, no solo tapa) el texto de: (1) la nota gris bajo «Caso de negocio» y
  (2) el bloque «Fuentes y método» + «Uso de IA». Reescribe ambos con la misma fuente (DejaVu Sans), color y
  tamaño (o el mayor que quepa). No toca tablas, proyecciones, título, roadmap ni la página 1.
- Falla si el texto no cabe en su caja o si el resultado no tiene exactamente 2 páginas.

Uso: python actualizar_notas_resumen.py <original.pdf> <salida.pdf> <DejaVuSans.ttf>   (requiere pymupdf)
"""
import sys

import pymupdf

src, out, font = sys.argv[1:4]
GRAY = (0x50 / 255, 0x62 / 255, 0x74 / 255)  # color de las notas originales (#506274)

NOTA_CASO = (
    "Umbral aproximado: tasa de servicio completado ≈ 53,3% (con otros supuestos base constantes). "
    "Sensibilidad: con ticket neto de 280.000 COP y los demás supuestos base, el VPN base sería ≈ −95,5 M COP "
    "y el umbral ≈ 72,3%; el ticket base se mantiene en 450.000 COP y es el supuesto crítico a validar. "
    "SOAT, seguros, recompra, historial externo y eficiencias no demostradas no aportan ingresos al modelo."
)
NOTA_FUENTES = (
    "Fuentes y método: [4] SIC, principios de Ley 1581. Escenarios del Modelo Financiero v1.0 (hojas COMITE, "
    "Supuestos, Base, Costos y Validacion), sin cambios. Hipótesis: tarifa LLM Sonnet 4.6, USD 3/15 por MTok "
    "(tarifa publicada, modelo a revalidar); 780 COP/conversación es una estimación, no una medición. La ventana de "
    "180 días es un criterio de segmentación del piloto, no una regla del motor técnico. Datos de agencia: hipótesis.\n"
    "Prototipo: datos sintéticos; CRM/DMS, agenda, autenticación y mensajería simulados (dependencias de "
    "integración; presupuesto provisional). La demo usa ScriptedLlm, una simulación: no se ha validado un LLM real. "
    "El protocolo de seguridad requiere aprobación de un responsable técnico antes de operar con clientes reales.\n"
    "Uso de IA: ChatGPT para análisis de propuesta, revisión de fuentes y documentos; Claude Code para diseño e "
    "implementación asistida. Supuestos, validación técnica y decisión final requieren revisión humana. "
    "Notas rev. 29 oct 2026."
)

# (área a redactar, caja de escritura, tamaño original) en puntos, origen arriba-izquierda.
BLOQUES = [
    ((36, 471.5, 560, 493.5), (39, 452, 557, 506), 7.45, NOTA_CASO),
    ((36, 735.5, 560, 792), (39, 731, 557, 805), 6.9, NOTA_FUENTES),
]

doc = pymupdf.open(src)
page = doc[1]
for redact, _, _, _ in BLOQUES:
    page.add_redact_annot(pymupdf.Rect(redact), fill=(1, 1, 1))
page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE)

for _, box, size, text in BLOQUES:
    for s in [round(size - 0.05 * i, 2) for i in range(0, 30)]:
        shape = page.new_shape()
        rest = shape.insert_textbox(pymupdf.Rect(box), text, fontname="dejavu", fontfile=font, fontsize=s, color=GRAY, lineheight=1.3)
        if rest >= 0:
            shape.commit()
            print(f"bloque en {box}: tamaño {s} pt, sobran {rest:.1f} pt")
            break
    else:
        sys.exit(f"El texto no cabe en {box}")

doc.set_metadata({**doc.metadata, "subject": "Notas actualizadas 2026-10-29 (decisiones del comité); proyecciones sin cambios"})
doc.save(out, garbage=3, deflate=True)
assert pymupdf.open(out).page_count == 2, "el resumen debe tener 2 páginas"
