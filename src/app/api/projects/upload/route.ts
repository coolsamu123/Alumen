import { NextRequest, NextResponse } from 'next/server';
import { parseExcelBuffer } from '@/lib/excel-parser';
import fs from 'fs';
import path from 'path';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) {
      return NextResponse.json({ error: 'File must be .xlsx or .xls' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // Save original file as backup
    const uploadsDir = path.join(process.cwd(), 'data', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(uploadsDir, `${timestamp}_${file.name}`);
    fs.writeFileSync(backupPath, buffer);

    // Parse and store in SQLite
    const result = parseExcelBuffer(buffer);

    return NextResponse.json({
      success: true,
      count: result.count,
      added: result.added,
      updated: result.updated,
      promoted: result.promoted,
      missing: result.missing,
      batchId: result.batchId,
      errors: result.errors,
      backup: backupPath,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
