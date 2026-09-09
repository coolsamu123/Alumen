import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const MAPPINGS_FILE = path.join(process.cwd(), 'data', 'service_mappings.json');
const CSV_FILE = '/home/samuel/Téléchargements/service_offering.csv';

// Reads mutable state — must not be prerendered at build time. See the note in
// api/drive/projects/route.ts.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    let mappings: { domain: string; owner: string }[] = [];
    if (fs.existsSync(MAPPINGS_FILE)) {
      mappings = JSON.parse(fs.readFileSync(MAPPINGS_FILE, 'utf-8'));
    }

    if (!fs.existsSync(CSV_FILE)) {
      return NextResponse.json({ services: [] });
    }

    const csvContent = fs.readFileSync(CSV_FILE, 'utf-8');
    const lines = csvContent.split('\n').filter(line => line.trim() !== '');
    if (lines.length < 2) return NextResponse.json({ services: [] });

    const headers = lines[0].split('","').map(h => h.replace(/^"|"$/g, ''));
    const ownedByIndex = headers.indexOf('owned_by');
    const nameIndex = headers.indexOf('name');

    if (ownedByIndex === -1 || nameIndex === -1) {
      return NextResponse.json({ error: 'Missing required columns in CSV' }, { status: 500 });
    }

    const services = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split('","').map(p => p.replace(/^"|"$/g, ''));
      if (parts.length <= Math.max(ownedByIndex, nameIndex)) continue;
      
      const owner = parts[ownedByIndex];
      const name = parts[nameIndex];
      
      if (!name) continue;

      const mapping = mappings.find(m => m.owner === owner);
      const domain = mapping ? mapping.domain : 'Unknown';

      services.push({
        id: name,
        name,
        owner,
        domain
      });
    }

    return NextResponse.json({ services });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
