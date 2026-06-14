//! Ontology REST routes — entity-type schemas, properties, and FUSE match rules.
//!
//! Ported from `services/api/src/routes/ontologies.ts` (legacy TS implementation).
//! Tables (see `migrations/007_ontologies.sql` and `019_ontology_scope_to_text.sql`):
//!   - `ontologies`             top-level container, owned by a user
//!   - `ontology_entity_types`  named entity types in an ontology
//!   - `ontology_properties`    properties on an entity type
//!   - `ontology_match_rules`   fusion rules between entity types
//!
//! All endpoints are mounted under `/api/ontologies` behind `require_auth` and
//! verify ownership against `claims.sub` on every query. Public/shared ontologies
//! are *readable* by any authenticated user but only writable by their owner
//! (or admin).

use axum::{
    extract::{Extension, Path, State},
    routing::{delete, get, post, put},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

use crate::{
    error::{AppError, Result},
    middleware::auth::JwtClaims,
};

/// The shared canonical "General Knowledge" ontology (see migration 036). It is
/// created at install, is the default for every user, and is **not deletable**.
const CANONICAL_ONTOLOGY_ID: Uuid = Uuid::from_u128(0xa1);

// ─── Templates (returned by GET /templates; not stored in DB) ────────────────

fn templates() -> Value {
    json!({
        "templates": [
            {
                "name": "CRM",
                "description": "Customer Relationship Management",
                "entityTypes": ["company", "contact", "account", "deal", "activity"],
                "source": "template",
            },
            {
                "name": "Supply Chain",
                "description": "Supply chain and logistics",
                "entityTypes": ["product", "supplier", "shipment", "warehouse", "order"],
                "source": "template",
            },
            {
                "name": "Healthcare",
                "description": "Healthcare and medical",
                "entityTypes": ["patient", "condition", "medication", "provider", "procedure"],
                "source": "template",
            },
            {
                "name": "Legal",
                "description": "Legal and compliance",
                "entityTypes": ["contract", "party", "clause", "jurisdiction", "regulation"],
                "source": "template",
            },
            {
                "name": "Finance",
                "description": "Financial services",
                "entityTypes": ["transaction", "account", "counterparty", "instrument", "portfolio"],
                "source": "template",
            },
            {
                "name": "Manufacturing",
                "description": "Manufacturing and production",
                "entityTypes": ["product", "component", "machine", "process", "defect"],
                "source": "template",
            },
            {
                "name": "Real Estate",
                "description": "Real estate and property",
                "entityTypes": ["property", "owner", "tenant", "transaction", "agent"],
                "source": "template",
            },
            {
                "name": "Education",
                "description": "Education and academia",
                "entityTypes": ["student", "course", "instructor", "institution", "credential"],
                "source": "template",
            },
        ]
    })
}

// ─── Request body types ──────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CreateOntologyReq {
    name:                                          String,
    description:                                   Option<String>,
    scope:                                         Option<String>,
    #[serde(rename = "parentOntologyId")]
    parent_ontology_id:                            Option<Uuid>,
}

#[derive(Deserialize)]
struct UpdateOntologyReq {
    name:        Option<String>,
    description: Option<String>,
    scope:       Option<String>,
}

#[derive(Deserialize)]
struct CreateEntityTypeReq {
    name:                                       String,
    qid:                                        Option<String>,
    aliases:                                    Option<Vec<String>>,
    description:                                Option<String>,
    #[serde(rename = "parentQid")]
    parent_qid:                                 Option<String>,
    #[serde(rename = "confidenceThreshold")]
    confidence_threshold:                       Option<f64>,
    color:                                      Option<String>,
}

#[derive(Deserialize)]
struct UpdateEntityTypeReq {
    name:                                       Option<String>,
    qid:                                        Option<String>,
    aliases:                                    Option<Vec<String>>,
    description:                                Option<String>,
    #[serde(rename = "parentQid")]
    parent_qid:                                 Option<String>,
    #[serde(rename = "confidenceThreshold")]
    confidence_threshold:                       Option<f64>,
    color:                                      Option<String>,
}

#[derive(Deserialize)]
struct CreatePropertyReq {
    name:                                       String,
    #[serde(rename = "dataType")]
    data_type:                                  Option<String>,
    required:                                   Option<bool>,
    searchable:                                 Option<bool>,
    #[serde(rename = "weightInMatching")]
    weight_in_matching:                         Option<f64>,
}

#[derive(Deserialize)]
struct CreateMatchRuleReq {
    #[serde(rename = "entityTypeA")]
    entity_type_a:                              String,
    #[serde(rename = "entityTypeB")]
    entity_type_b:                              String,
    #[serde(rename = "canMatch")]
    can_match:                                  Option<bool>,
    #[serde(rename = "similarityMetric")]
    similarity_metric:                          Option<String>,
    threshold:                                  Option<f64>,
    #[serde(rename = "blockingStrategy")]
    blocking_strategy:                          Option<String>,
    #[serde(rename = "propertiesToMatch")]
    properties_to_match:                        Option<Vec<String>>,
}

#[derive(Deserialize)]
struct ImportOntologyReq {
    data: ImportOntologyData,
}

#[derive(Deserialize)]
struct ImportOntologyData {
    name:        String,
    description: Option<String>,
    scope:       Option<String>,
    source:      Option<String>,
    #[serde(rename = "entityTypes", default)]
    entity_types: Vec<Value>,
    #[serde(rename = "matchRules", default)]
    match_rules:  Vec<Value>,
}

// ─── Router ──────────────────────────────────────────────────────────────────

pub fn router() -> Router<Arc<crate::models::AppState>> {
    Router::new()
        // NOTE: `/templates` MUST be registered before `/:id` so it isn't
        // treated as an ID by the path-router.
        .route("/templates",                                          get(get_templates))
        .route("/import",                                             post(import_ontology))
        .route("/",                                                   get(list).post(create))
        .route("/:id",                                                get(get_one).put(update).delete(delete_one))
        .route("/:id/export",                                         post(export))
        .route("/:id/entity-types",                                   post(create_entity_type))
        .route("/:id/entity-types/:typeId",                           put(update_entity_type).delete(delete_entity_type))
        .route("/:id/entity-types/:typeId/properties",                post(create_property))
        .route("/:id/properties/:propId",                             delete(delete_property))
        .route("/:id/match-rules",                                    post(create_match_rule))
        .route("/:id/match-rules/:ruleId",                            delete(delete_match_rule))
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn validate_scope(scope: &str) -> Result<()> {
    match scope {
        "private" | "shared" | "public" => Ok(()),
        _ => Err(AppError::BadRequest(
            "scope must be one of 'private', 'shared', 'public'".into(),
        )),
    }
}

/// Internal row shape used for ownership/visibility checks.
/// `user_id` is nullable: the shared canonical "General Knowledge" ontology is
/// system-owned (no specific user).
#[derive(sqlx::FromRow)]
struct OntologyOwnerRow {
    user_id: Option<Uuid>,
    scope:   String,
}

/// Resolve an ontology for read access.
/// - Owner: always allowed.
/// - Admin: always allowed.
/// - Otherwise: only allowed if the ontology is `shared` or `public`.
/// Returns `Ok(())` on success, `AppError::NotFound` if either the row doesn't
/// exist or the user is not allowed to see it (we deliberately don't leak the
/// distinction — 404 is correct for both cases).
async fn check_read_access(
    db:        &sqlx::PgPool,
    ontology_id: Uuid,
    user_id:   Uuid,
    role:      &str,
) -> Result<OntologyOwnerRow> {
    let row = sqlx::query_as::<_, OntologyOwnerRow>(
        "SELECT user_id, scope FROM ontologies WHERE id = $1",
    )
    .bind(ontology_id)
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)?;

    if role == "admin" || row.user_id == Some(user_id) || row.scope == "shared" || row.scope == "public" {
        Ok(row)
    } else {
        Err(AppError::NotFound)
    }
}

/// Resolve an ontology for write access (owner or admin only).
async fn check_write_access(
    db:          &sqlx::PgPool,
    ontology_id: Uuid,
    user_id:     Uuid,
    role:        &str,
) -> Result<()> {
    let row = sqlx::query_as::<_, OntologyOwnerRow>(
        "SELECT user_id, scope FROM ontologies WHERE id = $1",
    )
    .bind(ontology_id)
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)?;

    if role == "admin" || row.user_id == Some(user_id) {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "Only the owner or admin can modify this ontology".into(),
        ))
    }
}

/// Recompute and persist `entity_type_count` after entity-type create/delete/import.
async fn refresh_entity_type_count(db: &sqlx::PgPool, ontology_id: Uuid) -> Result<()> {
    sqlx::query(
        "UPDATE ontologies
         SET entity_type_count = (
                 SELECT COUNT(*) FROM ontology_entity_types WHERE ontology_id = $1
             ),
             updated_at = NOW()
         WHERE id = $1",
    )
    .bind(ontology_id)
    .execute(db)
    .await?;
    Ok(())
}

// ─── Row types for SELECT * style reads ──────────────────────────────────────

#[derive(sqlx::FromRow)]
struct OntologyRow {
    id:                                   Uuid,
    user_id:                              Option<Uuid>,
    name:                                 String,
    description:                          Option<String>,
    version:                              i32,
    parent_ontology_id:                   Option<Uuid>,
    scope:                                String,
    source:                               Option<String>,
    entity_type_count:                    i32,
    created_at:                           DateTime<Utc>,
    updated_at:                           DateTime<Utc>,
}

impl OntologyRow {
    fn to_json(&self) -> Value {
        json!({
            "id":                self.id,
            "userId":            self.user_id,
            "name":              self.name,
            "description":       self.description,
            "version":           self.version,
            "parentOntologyId":  self.parent_ontology_id,
            "scope":             self.scope,
            "source":            self.source,
            "entityTypeCount":   self.entity_type_count,
            "createdAt":         self.created_at,
            "updatedAt":         self.updated_at,
        })
    }
}

#[derive(sqlx::FromRow)]
struct EntityTypeRow {
    id:                    Uuid,
    ontology_id:           Uuid,
    qid:                   Option<String>,
    name:                  String,
    aliases:               Option<Vec<String>>,
    description:           Option<String>,
    parent_qid:            Option<String>,
    confidence_threshold:  Option<f64>,
    color:                 Option<String>,
    created_at:            DateTime<Utc>,
}

impl EntityTypeRow {
    fn to_json(&self, properties: Vec<Value>) -> Value {
        json!({
            "id":                   self.id,
            "ontologyId":           self.ontology_id,
            "qid":                  self.qid,
            "name":                 self.name,
            "aliases":              self.aliases.clone().unwrap_or_default(),
            "description":          self.description,
            "parentQid":            self.parent_qid,
            "confidenceThreshold":  self.confidence_threshold,
            "color":                self.color,
            "createdAt":            self.created_at,
            "properties":           properties,
        })
    }
}

#[derive(sqlx::FromRow)]
struct PropertyRow {
    id:                  Uuid,
    entity_type_id:      Uuid,
    name:                String,
    data_type:           Option<String>,
    required:            Option<bool>,
    searchable:          Option<bool>,
    weight_in_matching:  Option<f64>,
    created_at:          DateTime<Utc>,
}

impl PropertyRow {
    fn to_json(&self) -> Value {
        json!({
            "id":               self.id,
            "entityTypeId":     self.entity_type_id,
            "name":             self.name,
            "dataType":         self.data_type,
            "required":         self.required.unwrap_or(false),
            "searchable":       self.searchable.unwrap_or(true),
            "weightInMatching": self.weight_in_matching.unwrap_or(1.0),
            "createdAt":        self.created_at,
        })
    }
}

#[derive(sqlx::FromRow)]
struct MatchRuleRow {
    id:                   Uuid,
    ontology_id:          Uuid,
    entity_type_a:        String,
    entity_type_b:        String,
    can_match:            Option<bool>,
    similarity_metric:    Option<String>,
    threshold:            Option<f64>,
    blocking_strategy:    Option<String>,
    properties_to_match:  Option<Vec<String>>,
    created_at:           DateTime<Utc>,
}

impl MatchRuleRow {
    fn to_json(&self) -> Value {
        json!({
            "id":                this_or_null_uuid(self.id),
            "ontologyId":        self.ontology_id,
            "entityTypeA":       self.entity_type_a,
            "entityTypeB":       self.entity_type_b,
            "canMatch":          self.can_match.unwrap_or(true),
            "similarityMetric":  self.similarity_metric,
            "threshold":         self.threshold,
            "blockingStrategy":  self.blocking_strategy,
            "propertiesToMatch": self.properties_to_match.clone().unwrap_or_default(),
            "createdAt":         self.created_at,
        })
    }
}

#[inline]
fn this_or_null_uuid(id: Uuid) -> Value {
    json!(id)
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/// GET /api/ontologies/templates — returns hardcoded template list (no DB).
async fn get_templates(
    Extension(_claims): Extension<JwtClaims>,
) -> Result<Json<Value>> {
    Ok(Json(templates()))
}

/// GET /api/ontologies — list user's own + shared + public (admins see all).
async fn list(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
) -> Result<Json<Value>> {
    let rows = if claims.role == "admin" {
        sqlx::query_as::<_, OntologyRow>(
            "SELECT id, user_id, name, description, version, parent_ontology_id,
                    scope, source, entity_type_count, created_at, updated_at
             FROM ontologies
             ORDER BY updated_at DESC",
        )
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, OntologyRow>(
            "SELECT id, user_id, name, description, version, parent_ontology_id,
                    scope, source, entity_type_count, created_at, updated_at
             FROM ontologies
             WHERE user_id = $1 OR scope IN ('shared', 'public')
             ORDER BY updated_at DESC",
        )
        .bind(claims.sub)
        .fetch_all(&state.db)
        .await?
    };

    let ontologies: Vec<Value> = rows.iter().map(OntologyRow::to_json).collect();
    Ok(Json(json!({ "ontologies": ontologies })))
}

/// POST /api/ontologies — create empty ontology.
async fn create(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<CreateOntologyReq>,
) -> Result<Json<Value>> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("Name is required".into()));
    }
    if name.chars().count() > 255 {
        return Err(AppError::BadRequest("Name must be at most 255 characters".into()));
    }
    let scope = req.scope.unwrap_or_else(|| "private".into());
    validate_scope(&scope)?;

    let id = Uuid::new_v4();
    let row = sqlx::query_as::<_, OntologyRow>(
        "INSERT INTO ontologies
            (id, user_id, name, description, scope, parent_ontology_id,
             entity_type_count, version, source)
         VALUES ($1, $2, $3, $4, $5, $6, 0, 1, 'custom')
         RETURNING id, user_id, name, description, version, parent_ontology_id,
                   scope, source, entity_type_count, created_at, updated_at",
    )
    .bind(id)
    .bind(claims.sub)
    .bind(name)
    .bind(req.description.as_deref())
    .bind(&scope)
    .bind(req.parent_ontology_id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        // Handle UNIQUE(user_id, name) constraint with a friendly 409.
        if let sqlx::Error::Database(ref db_err) = e {
            if db_err.code().as_deref() == Some("23505") {
                return AppError::Conflict(format!(
                    "An ontology named '{name}' already exists for this user"
                ));
            }
        }
        AppError::Database(e)
    })?;

    Ok(Json(json!({
        "id":       row.id,
        "name":     row.name,
        "ontology": row.to_json(),
    })))
}

/// GET /api/ontologies/:id — returns ontology with entity types (with their
/// properties) and match rules attached.
async fn get_one(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    // Read-access check (owner / admin / shared / public).
    check_read_access(&state.db, id, claims.sub, &claims.role).await?;

    let ontology = sqlx::query_as::<_, OntologyRow>(
        "SELECT id, user_id, name, description, version, parent_ontology_id,
                scope, source, entity_type_count, created_at, updated_at
         FROM ontologies WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let entity_types = sqlx::query_as::<_, EntityTypeRow>(
        "SELECT id, ontology_id, qid, name, aliases, description, parent_qid,
                confidence_threshold, color, created_at
         FROM ontology_entity_types
         WHERE ontology_id = $1
         ORDER BY created_at ASC",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    // Fetch all properties for these entity types in one query (JOIN ensures
    // we filter by ontology even if a stale row referenced a removed type).
    let properties = sqlx::query_as::<_, PropertyRow>(
        "SELECT p.id, p.entity_type_id, p.name, p.data_type, p.required,
                p.searchable, p.weight_in_matching, p.created_at
         FROM ontology_properties p
         INNER JOIN ontology_entity_types et ON p.entity_type_id = et.id
         WHERE et.ontology_id = $1
         ORDER BY p.created_at ASC",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    let match_rules = sqlx::query_as::<_, MatchRuleRow>(
        "SELECT id, ontology_id, entity_type_a, entity_type_b, can_match,
                similarity_metric, threshold, blocking_strategy,
                properties_to_match, created_at
         FROM ontology_match_rules
         WHERE ontology_id = $1
         ORDER BY created_at ASC",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    // Attach properties to their entity types.
    let entity_types_json: Vec<Value> = entity_types
        .iter()
        .map(|et| {
            let props: Vec<Value> = properties
                .iter()
                .filter(|p| p.entity_type_id == et.id)
                .map(PropertyRow::to_json)
                .collect();
            et.to_json(props)
        })
        .collect();

    let match_rules_json: Vec<Value> = match_rules.iter().map(MatchRuleRow::to_json).collect();

    let mut ontology_json = ontology.to_json();
    let obj = ontology_json.as_object_mut().expect("OntologyRow::to_json returns object");
    obj.insert("entityTypes".into(), Value::Array(entity_types_json));
    obj.insert("matchRules".into(),  Value::Array(match_rules_json));

    Ok(Json(json!({ "ontology": ontology_json })))
}

/// PUT /api/ontologies/:id — update name / description / scope.
async fn update(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateOntologyReq>,
) -> Result<Json<Value>> {
    check_write_access(&state.db, id, claims.sub, &claims.role).await?;

    if let Some(ref scope) = req.scope {
        validate_scope(scope)?;
    }
    if let Some(ref name) = req.name {
        if name.trim().is_empty() {
            return Err(AppError::BadRequest("Name cannot be empty".into()));
        }
    }

    let row = sqlx::query_as::<_, OntologyRow>(
        "UPDATE ontologies
         SET name        = COALESCE($1, name),
             description = COALESCE($2, description),
             scope       = COALESCE($3, scope),
             updated_at  = NOW()
         WHERE id = $4
         RETURNING id, user_id, name, description, version, parent_ontology_id,
                   scope, source, entity_type_count, created_at, updated_at",
    )
    .bind(req.name.as_deref())
    .bind(req.description.as_deref())
    .bind(req.scope.as_deref())
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Json(json!({ "ontology": row.to_json() })))
}

/// DELETE /api/ontologies/:id — owner / admin only. Cascade removes children.
async fn delete_one(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    // The shared default ontology is permanent — present from install, never deletable.
    if id == CANONICAL_ONTOLOGY_ID {
        return Err(AppError::Forbidden(
            "The default ontology cannot be deleted.".into(),
        ));
    }

    check_write_access(&state.db, id, claims.sub, &claims.role).await?;

    sqlx::query("DELETE FROM ontologies WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;

    Ok(Json(json!({ "ok": true, "deleted": id })))
}

/// POST /api/ontologies/:id/entity-types — create new entity type.
async fn create_entity_type(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<CreateEntityTypeReq>,
) -> Result<Json<Value>> {
    check_write_access(&state.db, id, claims.sub, &claims.role).await?;

    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("Name is required".into()));
    }

    let aliases = req.aliases.unwrap_or_default();
    let confidence = req.confidence_threshold.unwrap_or(0.8);
    if !(0.0..=1.0).contains(&confidence) {
        return Err(AppError::BadRequest(
            "confidenceThreshold must be between 0 and 1".into(),
        ));
    }

    let new_id = Uuid::new_v4();
    let row = sqlx::query_as::<_, EntityTypeRow>(
        "INSERT INTO ontology_entity_types
            (id, ontology_id, name, qid, aliases, description, parent_qid,
             confidence_threshold, color)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, ontology_id, qid, name, aliases, description, parent_qid,
                   confidence_threshold, color, created_at",
    )
    .bind(new_id)
    .bind(id)
    .bind(name)
    .bind(req.qid.as_deref())
    .bind(&aliases)
    .bind(req.description.as_deref())
    .bind(req.parent_qid.as_deref())
    .bind(confidence)
    .bind(req.color.as_deref())
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if let sqlx::Error::Database(ref db_err) = e {
            if db_err.code().as_deref() == Some("23505") {
                return AppError::Conflict(format!(
                    "Entity type '{name}' already exists in this ontology"
                ));
            }
        }
        AppError::Database(e)
    })?;

    refresh_entity_type_count(&state.db, id).await?;

    Ok(Json(json!({ "entityType": row.to_json(Vec::new()) })))
}

/// PUT /api/ontologies/:id/entity-types/:typeId — partial update of entity type.
async fn update_entity_type(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path((id, type_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<UpdateEntityTypeReq>,
) -> Result<Json<Value>> {
    check_write_access(&state.db, id, claims.sub, &claims.role).await?;

    if let Some(c) = req.confidence_threshold {
        if !(0.0..=1.0).contains(&c) {
            return Err(AppError::BadRequest(
                "confidenceThreshold must be between 0 and 1".into(),
            ));
        }
    }
    if let Some(ref n) = req.name {
        if n.trim().is_empty() {
            return Err(AppError::BadRequest("Name cannot be empty".into()));
        }
    }

    // Aliases need explicit handling because COALESCE on TEXT[] needs an
    // explicit type cast. We pass aliases as Option<Vec<String>> and use
    // COALESCE($n::text[], aliases). Same trick for nullable text fields.
    let row = sqlx::query_as::<_, EntityTypeRow>(
        "UPDATE ontology_entity_types
         SET name                  = COALESCE($1, name),
             qid                   = COALESCE($2, qid),
             aliases               = COALESCE($3::text[], aliases),
             description           = COALESCE($4, description),
             parent_qid            = COALESCE($5, parent_qid),
             confidence_threshold  = COALESCE($6, confidence_threshold),
             color                 = COALESCE($7, color)
         WHERE id = $8 AND ontology_id = $9
         RETURNING id, ontology_id, qid, name, aliases, description, parent_qid,
                   confidence_threshold, color, created_at",
    )
    .bind(req.name.as_deref())
    .bind(req.qid.as_deref())
    .bind(req.aliases.as_ref())
    .bind(req.description.as_deref())
    .bind(req.parent_qid.as_deref())
    .bind(req.confidence_threshold)
    .bind(req.color.as_deref())
    .bind(type_id)
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Json(json!({ "entityType": row.to_json(Vec::new()) })))
}

/// DELETE /api/ontologies/:id/entity-types/:typeId — owner / admin only.
async fn delete_entity_type(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path((id, type_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    check_write_access(&state.db, id, claims.sub, &claims.role).await?;

    let result = sqlx::query(
        "DELETE FROM ontology_entity_types WHERE id = $1 AND ontology_id = $2",
    )
    .bind(type_id)
    .bind(id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    refresh_entity_type_count(&state.db, id).await?;

    Ok(Json(json!({ "ok": true, "deleted": type_id })))
}

/// POST /api/ontologies/:id/entity-types/:typeId/properties — add property.
async fn create_property(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path((id, type_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<CreatePropertyReq>,
) -> Result<Json<Value>> {
    check_write_access(&state.db, id, claims.sub, &claims.role).await?;

    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("Name is required".into()));
    }
    let weight = req.weight_in_matching.unwrap_or(1.0);
    if !(0.0..=10.0).contains(&weight) {
        return Err(AppError::BadRequest(
            "weightInMatching must be between 0 and 10".into(),
        ));
    }

    // Verify the entity type belongs to this ontology before inserting.
    let owner_check: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM ontology_entity_types
         WHERE id = $1 AND ontology_id = $2",
    )
    .bind(type_id)
    .bind(id)
    .fetch_optional(&state.db)
    .await?;

    if owner_check.is_none() {
        return Err(AppError::NotFound);
    }

    let prop_id = Uuid::new_v4();
    let row = sqlx::query_as::<_, PropertyRow>(
        "INSERT INTO ontology_properties
            (id, entity_type_id, name, data_type, required, searchable, weight_in_matching)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, entity_type_id, name, data_type, required, searchable,
                   weight_in_matching, created_at",
    )
    .bind(prop_id)
    .bind(type_id)
    .bind(name)
    .bind(req.data_type.as_deref().unwrap_or("string"))
    .bind(req.required.unwrap_or(false))
    .bind(req.searchable.unwrap_or(true))
    .bind(weight)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(json!({ "property": row.to_json() })))
}

/// DELETE /api/ontologies/:id/properties/:propId — uses join to verify the
/// property belongs to an entity type that belongs to this ontology.
async fn delete_property(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path((id, prop_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    check_write_access(&state.db, id, claims.sub, &claims.role).await?;

    // Verify property -> entity_type -> ontology chain matches.
    let exists: Option<Uuid> = sqlx::query_scalar(
        "SELECT p.id FROM ontology_properties p
         INNER JOIN ontology_entity_types et ON p.entity_type_id = et.id
         WHERE p.id = $1 AND et.ontology_id = $2",
    )
    .bind(prop_id)
    .bind(id)
    .fetch_optional(&state.db)
    .await?;

    if exists.is_none() {
        return Err(AppError::NotFound);
    }

    sqlx::query("DELETE FROM ontology_properties WHERE id = $1")
        .bind(prop_id)
        .execute(&state.db)
        .await?;

    Ok(Json(json!({ "ok": true, "deleted": prop_id })))
}

/// POST /api/ontologies/:id/match-rules — add fusion match rule.
async fn create_match_rule(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<CreateMatchRuleReq>,
) -> Result<Json<Value>> {
    check_write_access(&state.db, id, claims.sub, &claims.role).await?;

    let a = req.entity_type_a.trim();
    let b = req.entity_type_b.trim();
    if a.is_empty() || b.is_empty() {
        return Err(AppError::BadRequest("entityTypeA and entityTypeB are required".into()));
    }
    let threshold = req.threshold.unwrap_or(0.85);
    if !(0.0..=1.0).contains(&threshold) {
        return Err(AppError::BadRequest("threshold must be between 0 and 1".into()));
    }
    let props = req.properties_to_match.unwrap_or_default();

    let new_id = Uuid::new_v4();
    let row = sqlx::query_as::<_, MatchRuleRow>(
        "INSERT INTO ontology_match_rules
            (id, ontology_id, entity_type_a, entity_type_b, can_match,
             similarity_metric, threshold, blocking_strategy, properties_to_match)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, ontology_id, entity_type_a, entity_type_b, can_match,
                   similarity_metric, threshold, blocking_strategy,
                   properties_to_match, created_at",
    )
    .bind(new_id)
    .bind(id)
    .bind(a)
    .bind(b)
    .bind(req.can_match.unwrap_or(true))
    .bind(req.similarity_metric.as_deref().unwrap_or("jaccard"))
    .bind(threshold)
    .bind(req.blocking_strategy.as_deref())
    .bind(&props)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(json!({ "matchRule": row.to_json() })))
}

/// DELETE /api/ontologies/:id/match-rules/:ruleId
async fn delete_match_rule(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path((id, rule_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    check_write_access(&state.db, id, claims.sub, &claims.role).await?;

    let result = sqlx::query(
        "DELETE FROM ontology_match_rules WHERE id = $1 AND ontology_id = $2",
    )
    .bind(rule_id)
    .bind(id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    Ok(Json(json!({ "ok": true, "deleted": rule_id })))
}

/// POST /api/ontologies/:id/export — serialize ontology + entity types + match
/// rules to a portable JSON envelope. Read access is enough — anyone who can
/// see the ontology can export it.
async fn export(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    check_read_access(&state.db, id, claims.sub, &claims.role).await?;

    let ontology = sqlx::query_as::<_, OntologyRow>(
        "SELECT id, user_id, name, description, version, parent_ontology_id,
                scope, source, entity_type_count, created_at, updated_at
         FROM ontologies WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let entity_types = sqlx::query_as::<_, EntityTypeRow>(
        "SELECT id, ontology_id, qid, name, aliases, description, parent_qid,
                confidence_threshold, color, created_at
         FROM ontology_entity_types
         WHERE ontology_id = $1
         ORDER BY created_at ASC",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    let properties = sqlx::query_as::<_, PropertyRow>(
        "SELECT p.id, p.entity_type_id, p.name, p.data_type, p.required,
                p.searchable, p.weight_in_matching, p.created_at
         FROM ontology_properties p
         INNER JOIN ontology_entity_types et ON p.entity_type_id = et.id
         WHERE et.ontology_id = $1",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    let match_rules = sqlx::query_as::<_, MatchRuleRow>(
        "SELECT id, ontology_id, entity_type_a, entity_type_b, can_match,
                similarity_metric, threshold, blocking_strategy,
                properties_to_match, created_at
         FROM ontology_match_rules
         WHERE ontology_id = $1",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    let entity_types_json: Vec<Value> = entity_types
        .iter()
        .map(|et| {
            let props: Vec<Value> = properties
                .iter()
                .filter(|p| p.entity_type_id == et.id)
                .map(|p| json!({
                    "name":             p.name,
                    "dataType":         p.data_type,
                    "required":         p.required.unwrap_or(false),
                    "searchable":       p.searchable.unwrap_or(true),
                    "weightInMatching": p.weight_in_matching.unwrap_or(1.0),
                }))
                .collect();

            json!({
                "name":                et.name,
                "qid":                 et.qid,
                "aliases":             et.aliases.clone().unwrap_or_default(),
                "description":         et.description,
                "parentQid":           et.parent_qid,
                "confidenceThreshold": et.confidence_threshold,
                "color":               et.color,
                "properties":          props,
            })
        })
        .collect();

    let match_rules_json: Vec<Value> = match_rules
        .iter()
        .map(|r| json!({
            "entityTypeA":       r.entity_type_a,
            "entityTypeB":       r.entity_type_b,
            "canMatch":          r.can_match.unwrap_or(true),
            "similarityMetric":  r.similarity_metric,
            "threshold":         r.threshold,
            "blockingStrategy":  r.blocking_strategy,
            "propertiesToMatch": r.properties_to_match.clone().unwrap_or_default(),
        }))
        .collect();

    let export_data = json!({
        "exportVersion": 1,
        "exportedAt":    Utc::now().to_rfc3339(),
        "name":          ontology.name,
        "description":   ontology.description,
        "scope":         ontology.scope,
        "source":        ontology.source,
        "entityTypes":   entity_types_json,
        "matchRules":    match_rules_json,
    });

    Ok(Json(json!({ "export": export_data })))
}

/// POST /api/ontologies/import — bulk-create an ontology from a JSON envelope
/// (the same shape that POST /:id/export produces). The new ontology is owned
/// by the caller regardless of who exported the original.
async fn import_ontology(
    Extension(claims): Extension<JwtClaims>,
    State(state): State<Arc<crate::models::AppState>>,
    Json(req): Json<ImportOntologyReq>,
) -> Result<Json<Value>> {
    let data = req.data;

    let name = data.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("Imported ontology must have a name".into()));
    }

    let scope = data.scope.unwrap_or_else(|| "private".into());
    validate_scope(&scope)?;

    let source = data.source.unwrap_or_else(|| "import".into());

    // Use a transaction so an aborted import doesn't leave half-built state.
    let mut tx = state.db.begin().await?;

    let ontology_id = Uuid::new_v4();
    let ontology = sqlx::query_as::<_, OntologyRow>(
        "INSERT INTO ontologies
            (id, user_id, name, description, scope, source,
             entity_type_count, version)
         VALUES ($1, $2, $3, $4, $5, $6, 0, 1)
         RETURNING id, user_id, name, description, version, parent_ontology_id,
                   scope, source, entity_type_count, created_at, updated_at",
    )
    .bind(ontology_id)
    .bind(claims.sub)
    .bind(name)
    .bind(data.description.as_deref())
    .bind(&scope)
    .bind(&source)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        if let sqlx::Error::Database(ref db_err) = e {
            if db_err.code().as_deref() == Some("23505") {
                return AppError::Conflict(format!(
                    "An ontology named '{name}' already exists for this user"
                ));
            }
        }
        AppError::Database(e)
    })?;

    // Insert entity types and their properties.
    for et in &data.entity_types {
        let et_name = et.get("name").and_then(|v| v.as_str()).unwrap_or("Unknown");
        let qid = et.get("qid").and_then(|v| v.as_str());
        let aliases: Vec<String> = et.get("aliases")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let description = et.get("description").and_then(|v| v.as_str());
        let parent_qid  = et.get("parentQid").and_then(|v| v.as_str());
        let confidence  = et.get("confidenceThreshold").and_then(|v| v.as_f64()).unwrap_or(0.8);
        let color       = et.get("color").and_then(|v| v.as_str());

        let et_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO ontology_entity_types
                (id, ontology_id, name, qid, aliases, description, parent_qid,
                 confidence_threshold, color)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (ontology_id, name) DO NOTHING",
        )
        .bind(et_id)
        .bind(ontology_id)
        .bind(et_name)
        .bind(qid)
        .bind(&aliases)
        .bind(description)
        .bind(parent_qid)
        .bind(confidence)
        .bind(color)
        .execute(&mut *tx)
        .await?;

        // Re-resolve the actual entity type id (in case ON CONFLICT skipped insert).
        let actual_id: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM ontology_entity_types
             WHERE ontology_id = $1 AND name = $2",
        )
        .bind(ontology_id)
        .bind(et_name)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(actual_id) = actual_id else { continue };

        // Properties (if any).
        if let Some(props_arr) = et.get("properties").and_then(|v| v.as_array()) {
            for p in props_arr {
                let p_name      = p.get("name").and_then(|v| v.as_str()).unwrap_or("property");
                let data_type   = p.get("dataType").and_then(|v| v.as_str()).unwrap_or("string");
                let required    = p.get("required").and_then(|v| v.as_bool()).unwrap_or(false);
                let searchable  = p.get("searchable").and_then(|v| v.as_bool()).unwrap_or(true);
                let weight      = p.get("weightInMatching").and_then(|v| v.as_f64()).unwrap_or(1.0);

                sqlx::query(
                    "INSERT INTO ontology_properties
                        (id, entity_type_id, name, data_type, required, searchable,
                         weight_in_matching)
                     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)",
                )
                .bind(actual_id)
                .bind(p_name)
                .bind(data_type)
                .bind(required)
                .bind(searchable)
                .bind(weight)
                .execute(&mut *tx)
                .await?;
            }
        }
    }

    // Insert match rules.
    for r in &data.match_rules {
        let a = r.get("entityTypeA").and_then(|v| v.as_str()).unwrap_or("");
        let b = r.get("entityTypeB").and_then(|v| v.as_str()).unwrap_or("");
        if a.is_empty() || b.is_empty() {
            continue;
        }
        let can_match  = r.get("canMatch").and_then(|v| v.as_bool()).unwrap_or(true);
        let metric     = r.get("similarityMetric").and_then(|v| v.as_str()).unwrap_or("jaccard");
        let threshold  = r.get("threshold").and_then(|v| v.as_f64()).unwrap_or(0.85);
        let blocking   = r.get("blockingStrategy").and_then(|v| v.as_str());
        let props: Vec<String> = r.get("propertiesToMatch")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();

        sqlx::query(
            "INSERT INTO ontology_match_rules
                (id, ontology_id, entity_type_a, entity_type_b, can_match,
                 similarity_metric, threshold, blocking_strategy, properties_to_match)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(ontology_id)
        .bind(a)
        .bind(b)
        .bind(can_match)
        .bind(metric)
        .bind(threshold)
        .bind(blocking)
        .bind(&props)
        .execute(&mut *tx)
        .await?;
    }

    // Update entity_type_count inside the transaction.
    sqlx::query(
        "UPDATE ontologies
         SET entity_type_count = (
                 SELECT COUNT(*) FROM ontology_entity_types WHERE ontology_id = $1
             ),
             updated_at = NOW()
         WHERE id = $1",
    )
    .bind(ontology_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // Read back the final state for the response.
    let final_ontology = sqlx::query_as::<_, OntologyRow>(
        "SELECT id, user_id, name, description, version, parent_ontology_id,
                scope, source, entity_type_count, created_at, updated_at
         FROM ontologies WHERE id = $1",
    )
    .bind(ontology_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(ontology);

    Ok(Json(json!({ "ontology": final_ontology.to_json() })))
}
