// src/app/api/tax/route.ts — Korean investment tax calculator (reference only)
import { NextRequest, NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';

// Korean tax rules (2025-2026, subject to change — reference only)
const RULES: Record<string, { deduction: number; rate: number; note: string }> = {
  crypto:   { deduction: 2_500_000, rate: 0.20, note: '가상자산 소득세 (기본공제 250만원, 세율 20%) — 2025년 시행 예정' },
  stock_us: { deduction: 2_500_000, rate: 0.22, note: '해외주식 양도소득세 (기본공제 250만원, 세율 22%)' },
  stock_kr: { deduction: 0,         rate: 0,    note: '국내주식 소액주주 비과세 (대주주 해당 시 별도 신고)' },
  futures:  { deduction: 2_500_000, rate: 0.20, note: '파생상품 소득세 (기본공제 250만원, 세율 20%)' },
};

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}

  const { assetType = 'crypto', profit = 0, feesPaid = 0, year = 2026 } = body;
  const rule = RULES[assetType] ?? RULES.crypto;

  const netProfit    = Math.max(0, profit - feesPaid);
  const taxableProfit = Math.max(0, netProfit - rule.deduction);
  const estimatedTax = Math.round(taxableProfit * rule.rate);
  const localTax     = Math.round(estimatedTax * 0.1); // 지방소득세 10%
  const totalTax     = estimatedTax + localTax;

  return NextResponse.json({
    ok:           true,
    year,
    assetType,
    profit:       profit,
    feesPaid:     feesPaid,
    netProfit:    netProfit,
    deduction:    rule.deduction,
    taxableProfit,
    taxRate:      rule.rate,
    estimatedTax,
    localTax,
    totalTax,
    netAfterTax:  profit - feesPaid - totalTax,
    ruleNote:     rule.note,
    note: `참고용 계산입니다. ${year}년 세법 기준이며 실제 신고 전 세무 전문가 확인이 필요합니다.`,
  });
}

// GET: return rules info
export async function GET() {
  return NextResponse.json({ ok:true, rules: RULES,
    note: '참고용 세율 정보입니다. 실제 신고 전 세무 전문가 확인 필요.' });
}
