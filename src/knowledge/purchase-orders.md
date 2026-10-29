# Purchase-order process knowledge

The package contains the requester email, normalized request, supplier quote, manager approval, and sometimes an invoice. Tools—not the language model—read and validate those files.

RC1–RC4 and RC10 are blockers: supplier status, approval authority, approval limit, cost-center subarea, and request arithmetic must be valid. RC5, RC6, RC8, and RC9 require explicit analyst confirmation: quote variance or absence, derived tax code, retroactive invoice, or approval predating the request. RC7 derives missing payment terms and is informational.

A retroactive PO has an invoice dated before the purchase request. It is measurable process debt and requires confirmation; it is not silently converted into a normal PO.

Explain exceptions with the RC code, source values, operational risk, and a direct confirmation question. A manager's approval email authorizes the expenditure; it does not replace the analyst's confirmation of an exception.
