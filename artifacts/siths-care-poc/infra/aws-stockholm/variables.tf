variable "oidc_profile" {
  description = "Explicit isolated federation profile; never selects a Traivo company."
  type        = string
  default     = "generic"
  validation {
    condition     = contains(["generic", "region-stockholm-test"], var.oidc_profile)
    error_message = "Use generic or region-stockholm-test."
  }
}

variable "oidc_scopes" {
  description = "Space-separated scopes agreed with the IdP; must include openid."
  type        = string
  default     = "openid"
  validation {
    condition     = contains(split(" ", var.oidc_scopes), "openid")
    error_message = "OIDC scopes must include openid."
  }
}

variable "expected_aws_account_id" {
  description = "Dedicated pilot AWS account ID. Never use a shared product account."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_aws_account_id))
    error_message = "expected_aws_account_id must be exactly 12 digits."
  }
}

variable "name" {
  type    = string
  default = "siths-care-pilot"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name))
    error_message = "name must be a short lowercase resource prefix."
  }
}

variable "environment" {
  type    = string
  default = "pilot"
}

variable "image_uri" {
  description = "Immutable Node artifact image URI, preferably pinned by sha256 digest."
  type        = string
  nullable    = false
  validation {
    condition     = strcontains(var.image_uri, "@sha256:")
    error_message = "image_uri must be immutable and pinned with @sha256:."
  }
}

variable "certificate_arn" {
  description = "Validated ACM certificate ARN in eu-north-1."
  type        = string
  nullable    = false
}

variable "oidc_secret_arn" {
  description = "Existing Secrets Manager ARN containing issuer, clientId, clientSecret, redirectUri and allowedMetadataOrigins. Null creates metadata-only empty secret."
  type        = string
  default     = null
  nullable    = true
  validation {
    condition     = var.oidc_secret_arn == null || can(regex("^arn:aws:secretsmanager:eu-north-1:[0-9]{12}:secret:.+$", var.oidc_secret_arn))
    error_message = "oidc_secret_arn must be a Secrets Manager ARN in eu-north-1."
  }
}

variable "readiness_evidence_secret_arn" {
  description = "Existing secret ARN containing a JSON manifest key named manifest. Null creates metadata-only empty secret."
  type        = string
  default     = null
  nullable    = true
  validation {
    condition     = var.readiness_evidence_secret_arn == null || can(regex("^arn:aws:secretsmanager:eu-north-1:[0-9]{12}:secret:.+$", var.readiness_evidence_secret_arn))
    error_message = "readiness_evidence_secret_arn must be a Secrets Manager ARN in eu-north-1."
  }
}

variable "hosted_zone_id" {
  description = "Optional existing Route53 public hosted zone ID."
  type        = string
  default     = null
  nullable    = true
}

variable "domain_name" {
  description = "Optional DNS name. Required together with hosted_zone_id."
  type        = string
  default     = null
  nullable    = true
}

variable "alarm_email" {
  description = "Optional SNS email subscription; confirmation remains an external blocking step."
  type        = string
  default     = null
  nullable    = true
}

variable "desired_count" {
  type    = number
  default = 2
  validation {
    condition     = var.desired_count >= 2
    error_message = "At least two tasks are required for the pilot."
  }
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "audit_retention_days" {
  description = "Explicitly approved application audit retention used for DynamoDB TTL."
  type        = number
  nullable    = false
  validation {
    condition     = var.audit_retention_days >= 1 && var.audit_retention_days <= 3650 && floor(var.audit_retention_days) == var.audit_retention_days
    error_message = "audit_retention_days must be an explicitly approved integer from 1 through 3650."
  }
}

variable "audit_hmac_key_versions" {
  description = "Managed HMAC key versions. Never remove an older version while retained audit may reference it."
  type        = set(string)
  default     = ["v1"]
  validation {
    condition = (
      length(var.audit_hmac_key_versions) > 0 &&
      alltrue([for version in var.audit_hmac_key_versions : can(regex("^v[1-9][0-9]*$", version))])
    )
    error_message = "audit_hmac_key_versions must contain at least one version named v1, v2, and so on."
  }
}

variable "current_audit_hmac_key_version" {
  description = "Managed HMAC version used to generate new audit MACs."
  type        = string
  default     = "v1"
  validation {
    condition     = can(regex("^v[1-9][0-9]*$", var.current_audit_hmac_key_version))
    error_message = "current_audit_hmac_key_version must be named v1, v2, and so on."
  }
}

variable "previous_audit_hmac_key_arns" {
  description = "Optional externally managed older HMAC keys used only for verification."
  type        = list(string)
  default     = []
  validation {
    condition = alltrue([
      for arn in var.previous_audit_hmac_key_arns :
      can(regex("^arn:aws:kms:eu-north-1:[0-9]{12}:key/", arn))
    ])
    error_message = "Every previous audit HMAC key ARN must be a KMS key ARN in eu-north-1."
  }
}

variable "evidence_retention_days" {
  description = "Approved immutable evidence retention. Required because COMPLIANCE Object Lock cannot be shortened."
  type        = number
  nullable    = false
  validation {
    condition     = var.evidence_retention_days >= 1 && var.evidence_retention_days <= 3650
    error_message = "evidence_retention_days must be an explicitly approved value from 1 through 3650."
  }
}