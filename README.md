# Registro Verde 🌱
### A GeoAI-enabled solution for smallholder farmers' EUDR compliance

**Registro Verde** is an interactive geospatial dashboard prototype developed in the context of the Copernicus Master in Digital Earth thesis, *The Transformative Power of GeoAI: A Case Study for Smallholder Farmers' EUDR Compliance*.

The solution explores how Geospatial Artificial Intelligence (GeoAI), Earth Observation (EO), and accessible digital tools can help bridge the gap between increasingly demanding environmental regulations and the practical realities of smallholder farmers.

The case study focuses on smallholder coffee and cacao farmers in Colombia and the challenges of preparing plot-level geospatial information for the European Union Deforestation Regulation (EUDR).

**[Launch the Registro Verde demo](https://dsdkg86ub6jvm.cloudfront.net/)**

**[Explore the thesis and research framework](https://nicolevasos.github.io/cde-master-thesis/)**

---

## 1. Background and motivation

The European Union Deforestation Regulation introduces requirements for demonstrating that relevant commodities and products are not associated with deforestation and comply with applicable legal requirements.

For smallholder farmers, meeting these requirements can involve significant technical and administrative challenges. Accurate production-plot boundaries, reliable geolocation information, and interpretable evidence are essential components of the compliance process.

However, access to geospatial technology and the capacity to interpret complex technical outputs are not equally distributed.

Registro Verde explores a farmer-centred approach to this challenge: translating geospatial processing and analytical results into understandable, plot-level information that can support verification, communication, and compliance-related decision-making.

## 2. Objectives

The solution contributes to three overarching research objectives:

- **Geospatial validation:** Support the assessment and verification of production-plot geometries.
- **GeoAI and Earth Observation integration:** Connect geospatial information with analytical evidence relevant to compliance assessment.
- **Accessible communication:** Present technical results through an interactive dashboard designed to make plot-level information more understandable to users with limited technical capacity.

The broader research also examines how this approach could be transferred to other commodities, regions, and regulatory contexts.

## 3. The solution

Registro Verde is the interactive dashboard component of a broader GeoAI compliance framework. It provides a user-facing environment for exploring geospatial information and interacting with selected analytical functions.

The wider framework is organised into five connected phases:

| Phase | Purpose |
|---|---|
| P0 — Harmonisation | Standardise input formats, coordinate reference systems, and attributes. |
| P1 — Topology repair | Identify and address relevant geometric inconsistencies. |
| P2 — Farmer queue | Organise plots and cases requiring review or further action. |
| P3 — WHISP integration | Connect plot geometries with the WHISP analytical service. |
| P4 — Additional evidence | Incorporate further evidence to support a more comprehensive assessment. |

Together, these phases illustrate how heterogeneous geographic inputs can be transformed into more consistent and interpretable information for compliance workflows.

*The dashboard is a research prototype and should not be interpreted as an official EUDR certification system.*

## 4. WHISP integration

Registro Verde integrates with the WHISP service through a serverless backend. The frontend submits GeoJSON data to a dedicated API endpoint, which processes the request and communicates with the external service.

The integration is intended to connect plot-level geometries with additional geospatial analysis within the wider compliance workflow.

The production endpoint is accessed through AWS API Gateway, with processing handled by AWS Lambda. API credentials are stored server-side using AWS Secrets Manager rather than exposed in browser code.

## 5. Technology and architecture

The deployed prototype uses a lightweight web frontend and a serverless backend.

```text
User
 |
 v
Registro Verde dashboard
 |
 v
Amazon CloudFront
 |
 v
Amazon API Gateway
 |
 v
AWS Lambda
 |
 +---- AWS Secrets Manager
 |
 v
WHISP API
```

### Technology stack

- **Frontend:** HTML, CSS, and JavaScript
- **Web delivery:** Amazon CloudFront
- **API layer:** Amazon API Gateway HTTP API
- **Backend processing:** AWS Lambda
- **Credential management:** AWS Secrets Manager
- **Geospatial exchange:** GeoJSON
- **External analytical integration:** WHISP

The serverless architecture separates the user interface from backend processing and keeps external API credentials outside the client-side application.

## 6. Explore the prototype

The deployed application can be accessed here:

**[Open Registro Verde](https://dsdkg86ub6jvm.cloudfront.net/)**

The prototype forms part of a research investigation into how geospatial intelligence can be made more accessible and actionable for users facing regulatory and technical barriers.

Its purpose is to demonstrate a possible workflow and architecture, not to replace official due-diligence procedures, competent authorities, or professional compliance assessments.

## 7. Research context

Registro Verde is associated with the following research:

**Thesis:** *The Transformative Power of GeoAI: A Case Study for Smallholder Farmers' EUDR Compliance*

**Programme:** Copernicus Master in Digital Earth (CDE)

**Author:** Nicole Salazar-Cuellar

**Year:** 2026

The research was submitted in partial fulfilment of the requirements for the joint Master's degree awarded by Paris Lodron University of Salzburg and Palacký University Olomouc.

For the research background, methodology, wider pipeline, and thesis materials, visit the [Master's thesis website](https://nicolevasos.github.io/cde-master-thesis/).

## 8. Running locally

Clone the repository:

```bash
git clone https://github.com/nicolevasos/geocitizens-dashboard-demo.git
cd geocitizens-dashboard-demo
```

For basic frontend exploration, start a local web server from the project root:

```bash
python3 -m http.server 5500
```

Then open [http://localhost:5500](http://localhost:5500).

The repository also includes backend-related files and Docker configuration. Follow the relevant project configuration when setting up backend services locally.

### WHISP configuration

The frontend's WHISP mode is configured in `js/whisp.js`. Available modes include:

- `mock` — test the frontend with mock data.
- `proxy` — use the configured proxy mode.
- `local` — connect to a local backend.
- `api` — connect to the deployed AWS API.

For production use, configure the API mode to point to the appropriate API Gateway endpoint. Do not place API keys or other credentials in frontend code.

## 9. Security and responsible use

- Keep external service credentials in secure server-side storage.
- Never commit secrets, access keys, or private configuration files to the repository.
- Restrict backend permissions according to the principle of least privilege.
- Monitor cloud resource usage and external API costs.
- Treat analytical outputs as decision-support evidence that may require further review.
- Protect farmers' personal information and sensitive production-location data.

## 10. Limitations and future directions

Registro Verde is a prototype within a broader research framework. Further work could investigate:

- Usability and accessibility with intended users.
- Validation of analytical outputs against independent evidence.
- Performance under limited-connectivity conditions.
- Integration of additional Earth Observation and geospatial evidence.
- Transferability to other commodities and regulatory contexts.
- Governance, data protection, and operational requirements for real-world deployment.

The broader research premise is that GeoAI can contribute to more accessible compliance workflows when technical rigour is combined with human-centred design.

## 11. Acknowledgements

Developed in the context of the Copernicus Master in Digital Earth programme and the thesis *The Transformative Power of GeoAI: A Case Study for Smallholder Farmers' EUDR Compliance*.

For further information, see the [thesis website](https://nicolevasos.github.io/cde-master-thesis/).

## License

`GeoCitizens`.
