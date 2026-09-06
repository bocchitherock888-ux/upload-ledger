"""Create synthetic local PDF fixtures, without user documents or external assets."""
from pathlib import Path

out=Path(__file__).resolve().parents[1]/'tests/fixtures'
out.mkdir(exist_ok=True)
def make_pdf(name,pages=2,javascript=False):
    objects=[]
    def add(body):
        objects.append(body.encode('ascii'))
        return len(objects)
    add('<< /Type /Catalog /Pages 2 0 R'+(' /OpenAction << /S /JavaScript /JS (globalThis.__UL_PDF_RAN=true;) >>' if javascript else '')+' >>')
    add('')
    font=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    kids=[]
    for i in range(pages):
        content=f'BT /F1 22 Tf 50 740 Td (Upload Ledger - synthetic page {i+1}) Tj 0 -40 Td /F1 12 Tf (Local PDF preview and offline rendering test.) Tj ET'
        stream=add(f'<< /Length {len(content)} >>\nstream\n{content}\nendstream')
        kids.append(add(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 {font} 0 R >> >> /Contents {stream} 0 R >>'))
    objects[1]=f'<< /Type /Pages /Count {pages} /Kids [{" ".join(str(k)+" 0 R" for k in kids)}] >>'.encode('ascii')
    data=bytearray(b'%PDF-1.7\n');offsets=[0]
    for i,obj in enumerate(objects,1):
        offsets.append(len(data));data.extend(f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n')
    xref=len(data);data.extend(f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:data.extend(f'{offset:010d} 00000 n \n'.encode())
    data.extend(f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    (out/name).write_bytes(data)
make_pdf('synthetic-preview.pdf',javascript=True)
make_pdf('synthetic-over-limit.pdf',pages=501)
print('Created two synthetic PDF fixtures in tests/fixtures')
