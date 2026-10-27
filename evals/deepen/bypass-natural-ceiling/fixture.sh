#!/usr/bin/env bash
# Runs in the empty eval workspace (only with --scaffold). Invented Q3 exports: orders and costs per month.
set -euo pipefail
mkdir -p data
cat > data/orders-2026-q3.csv <<'CSV'
order_id,date,customer,region,net_eur
1001,2026-07-03,Kunde A,Wien,1200.00
1002,2026-07-11,Kunde B,Graz,450.50
1003,2026-07-28,Kunde C,Wien,2300.00
1004,2026-08-02,Kunde A,Wien,980.00
1005,2026-08-19,Kunde D,Linz,3100.00
1006,2026-08-30,Kunde B,Graz,-450.50
1007,2026-09-05,Kunde E,Wien,1750.00
1008,2026-09-14,Kunde C,Wien,2300.00
1009,2026-09-29,Kunde F,Salzburg,640.00
CSV
cat > data/costs-2026-q3.csv <<'CSV'
month,category,eur
2026-07,Personal,5200
2026-07,Software,410
2026-08,Personal,5200
2026-08,Software,410
2026-08,Marketing,900
2026-09,Personal,5400
2026-09,Software,430
CSV
cat > data/README.txt <<'TXT'
Exporte aus dem Buchhaltungssystem, Stand 2026-10-02. order_id 1006 ist eine Gutschrift zu 1002.
TXT
