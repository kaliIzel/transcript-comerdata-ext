from io import BytesIO

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


def paragraphs(segments):
    pending = []
    length = 0
    end = None
    for segment in segments:
        if pending and (length >= 650 or (end is not None and segment["start"] - end >= 3)):
            yield " ".join(pending)
            pending = []
            length = 0
        text = " ".join(segment["text"].split())
        if text:
            pending.append(text)
            length += len(text) + 1
        end = segment.get("end")
    if pending:
        yield " ".join(pending)


def transcript_docx(title, lessons, combined):
    doc = Document()
    doc.core_properties.title = title
    doc.core_properties.author = "Transcript"
    section = doc.sections[0]
    section.page_width, section.page_height = Inches(8.5), Inches(11)
    section.top_margin = section.bottom_margin = Inches(0.8)
    section.left_margin = section.right_margin = Inches(0.85)

    for name, size in (("Normal", 11), ("Title", 26), ("Subtitle", 13), ("Heading 1", 17), ("Heading 2", 13)):
        style = doc.styles[name]
        style.font.name = "Calibri"
        style.font.size = Pt(size)
        style.font.color.rgb = RGBColor(0, 0, 0)
        if name != "Normal":
            style.paragraph_format.keep_with_next = True
    title_properties = doc.styles["Title"].element.find(qn("w:pPr"))
    if title_properties is not None:
        for border in title_properties.findall(qn("w:pBdr")):
            title_properties.remove(border)
    normal = doc.styles["Normal"].paragraph_format
    normal.space_after = Pt(8)
    normal.line_spacing = 1.15

    doc.add_paragraph(title, "Title")
    doc.add_paragraph("Transcripción de las lecciones guardadas" if combined else "Transcripción de la lección")
    last_module = None
    for lesson in lessons:
        if combined:
            if lesson["module"] != last_module:
                doc.add_heading(lesson["moduleTitle"], level=1)
                last_module = lesson["module"]
            doc.add_heading(lesson["title"], level=2)
        elif lesson.get("moduleTitle"):
            doc.add_paragraph(lesson["moduleTitle"], "Subtitle")
        for paragraph in paragraphs(lesson["segments"]):
            doc.add_paragraph(paragraph)
    output = BytesIO()
    doc.save(output)
    return output.getvalue()
