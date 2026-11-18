// Reporter de node:test para GitHub Actions: cada prueba que falla se publica como anotación ::error
// (aparece en el resumen del run y en el pull request con archivo, línea y mensaje).
import path from 'node:path';
const limpiar = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
export default async function* reporteGithub(source) {
  for await (const { type, data } of source) {
    if (type !== 'test:fail' || data.details?.type === 'suite') continue;
    const causa = data.details?.error?.cause ?? data.details?.error;
    const archivo = data.file ? path.relative(process.cwd(), data.file).split(path.sep).join('/') : '';
    const msg = `${data.name}: ${causa?.message ?? causa}`.slice(0, 900);
    yield `::error file=${archivo},line=${data.line ?? 1},title=Prueba fallida::${limpiar(msg)}\n`;
  }
}
