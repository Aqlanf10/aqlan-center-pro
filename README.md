# عقلان سنتر برو | Aqlan Center Pro

Owned by **Dr. Aqlan Alkamel — الدكتور عقلان الكامل**. Proprietary; all rights reserved.

Integrated multispecialty dental platform, designed for multiple branches, Arabic RTL, legacy patient migration, and YER/SAR/USD accounting. Target hosting: Railway frontend, backend and PostgreSQL.

## Current milestone

First domain foundation only: exact currency conversion and reviewed legacy opening-balance proposals. **Not a working clinic application; no production deployment or patient-data storage.**

Run on Node 24:

```sh
npm test
```

No external dependencies. Ten tests cover old orthodontic balances, uncertain data, historic patient credit, exchange direction, rounding and invalid values. Database transactions, authorization and durable idempotency remain to be implemented and tested.

See [implementation scope and roadmap](docs/IMPLEMENTATION.md). Existing Mini and Dental repositories are references and have not been modified by this project.
