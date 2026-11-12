provider "aws" {
  region              = "eu-north-1"
  allowed_account_ids = [var.expected_aws_account_id]

  default_tags {
    tags = {
      Application = var.name
      Environment = var.environment
      ManagedBy   = "Terraform"
      DataRegion  = "eu-north-1"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

resource "terraform_data" "deployment_contract" {
  lifecycle {
    precondition {
      condition     = data.aws_region.current.name == "eu-north-1"
      error_message = "Deployment is contractually restricted to eu-north-1."
    }
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.expected_aws_account_id
      error_message = "Active AWS account does not match expected_aws_account_id."
    }
    precondition {
      condition     = (var.hosted_zone_id == null) == (var.domain_name == null)
      error_message = "hosted_zone_id and domain_name must be set together."
    }
    precondition {
      condition     = can(regex("^arn:aws:acm:eu-north-1:${var.expected_aws_account_id}:certificate/", var.certificate_arn))
      error_message = "certificate_arn must belong to the expected account in eu-north-1."
    }
    precondition {
      condition = alltrue([
        for arn in var.previous_audit_hmac_key_arns :
        can(regex("^arn:aws:kms:eu-north-1:${var.expected_aws_account_id}:key/", arn))
      ])
      error_message = "Previous audit HMAC keys must belong to the expected account in eu-north-1."
    }
    precondition {
      condition     = contains(var.audit_hmac_key_versions, var.current_audit_hmac_key_version)
      error_message = "current_audit_hmac_key_version must remain in audit_hmac_key_versions."
    }
    precondition {
      condition = (
        var.oidc_secret_arn == null ||
        can(regex("^arn:aws:secretsmanager:eu-north-1:${var.expected_aws_account_id}:secret:.+$", var.oidc_secret_arn))
      )
      error_message = "oidc_secret_arn must belong to the expected account in eu-north-1."
    }
    precondition {
      condition = (
        var.readiness_evidence_secret_arn == null ||
        can(regex("^arn:aws:secretsmanager:eu-north-1:${var.expected_aws_account_id}:secret:.+$", var.readiness_evidence_secret_arn))
      )
      error_message = "readiness_evidence_secret_arn must belong to the expected account in eu-north-1."
    }
  }
}