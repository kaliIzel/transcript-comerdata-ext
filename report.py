from functools import lru_cache
from io import BytesIO
import os
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate


@lru_cache(maxsize=1)
def fonts():
    windows_fonts = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    regular, bold = windows_fonts / "arial.ttf", windows_fonts / "arialbd.ttf"
    if regular.is_file() and bold.is_file():
        pdfmetrics.registerFont(TTFont("Transcript", str(regular)))
        pdfmetrics.registerFont(TTFont("TranscriptBold", str(bold)))
        return "Transcript", "TranscriptBold"
    return "Helvetica", "Helvetica-Bold"


def transcript_pdf(title, lessons, combined):
    buffer = BytesIO()
    document = SimpleDocTemplate(
        buffer, pagesize=A4, leftMargin=55, rightMargin=55, topMargin=52,
        bottomMargin=55, title=title, author="Transcript",
    )
    regular, bold = fonts()
    ink, muted, accent = map(colors.HexColor, ("#172633", "#536477", "#205E59"))
    body = ParagraphStyle("Body", fontName=regular, fontSize=11, leading=16, textColor=ink,
                          alignment=TA_LEFT, spaceAfter=10)
    heading = ParagraphStyle("Heading", parent=body, fontName=bold, fontSize=13, leading=17,
                             spaceBefore=13, spaceAfter=7, keepWithNext=True)
    module_style = ParagraphStyle("Module", parent=heading, fontSize=17, leading=21, spaceBefore=17)
    label = ParagraphStyle("Label", parent=body, fontName=bold, fontSize=9, leading=13, textColor=accent,
                           spaceAfter=8, keepWithNext=True)
    title_style = ParagraphStyle("Title", parent=heading, fontSize=26, leading=31, spaceBefore=0, spaceAfter=18)
    story = [
        Paragraph("TRANSCRIPT / COMERDATA", label),
        Paragraph(escape(title), title_style),
    ]
    last_module = None
    for lesson in lessons:
        if combined and lesson.get("module") != last_module and lesson.get("moduleTitle"):
            story.append(Paragraph(escape(lesson["moduleTitle"]), module_style))
            last_module = lesson["module"]
        story.append(Paragraph(escape(lesson["title"]) if combined else "Transcripción", heading))
        for segment in lesson["segments"]:
            minutes, seconds = divmod(int(segment["start"]), 60)
            stamp = f"{minutes:02d}:{seconds:02d}"
            story.append(Paragraph(
                f'<font name="{bold}" color="#205E59">{stamp}</font>&nbsp;&nbsp;'
                + escape(segment["text"]).replace("\n", "<br/>"), body
            ))

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(colors.HexColor("#CCD6DE"))
        canvas.line(doc.leftMargin, 40, A4[0] - doc.rightMargin, 40)
        canvas.setFont(regular, 9)
        canvas.setFillColor(muted)
        canvas.drawString(doc.leftMargin, 25, "Transcripción del curso" if combined else "Transcripción de la lección")
        canvas.drawRightString(A4[0] - doc.rightMargin, 25, str(doc.page))
        canvas.restoreState()

    document.build(story, onFirstPage=footer, onLaterPages=footer)
    return buffer.getvalue()
