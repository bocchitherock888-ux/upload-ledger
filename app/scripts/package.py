from pathlib import Path
import zipfile,hashlib,json
root=Path(__file__).resolve().parents[1]
out=root.parent/'deliverables'
out.mkdir(exist_ok=True)
manifest=json.loads((root/'dist/manifest.json').read_text())
assert manifest.get('host_permissions') is None
assert manifest['permissions']==['activeTab','scripting','unlimitedStorage','alarms']
for name in ['background.js','content.js','app.html','popup.html']:
 assert (root/'dist'/name).is_file(),name
archive=out/('UploadLedger-'+manifest['version']+'.zip')
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as z:
 for path in sorted((root/'dist').rglob('*')):
  if path.is_file():
   name=path.relative_to(root/'dist').as_posix()
   assert not name.endswith(('.map','.DS_Store'))
   info=zipfile.ZipInfo(name,date_time=(2026,1,1,0,0,0))
   info.compress_type=zipfile.ZIP_DEFLATED
   info.external_attr=0o644 << 16
   z.writestr(info,path.read_bytes())
(out/'SHA256SUMS.txt').write_text(hashlib.sha256(archive.read_bytes()).hexdigest()+'  '+archive.name+'\n')
print(archive)
