data "aws_iam_policy_document" "kms" {
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.expected_aws_account_id}:root"]
    }
  }
  statement {
    sid = "CloudWatchLogsEncryption"
    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
    ]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.eu-north-1.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:eu-north-1:${var.expected_aws_account_id}:log-group:/aws/${var.name}/*"]
    }
  }
  statement {
    sid = "CloudTrailEncryption"
    actions = [
      "kms:DescribeKey",
      "kms:GenerateDataKey*",
    ]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudtrail:eu-north-1:${var.expected_aws_account_id}:trail/${var.name}"]
    }
  }
}

resource "aws_kms_key" "data" {
  description             = "${var.name} auth, audit, logs and evidence encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_kms_key" "audit_hmac" {
  for_each                 = var.audit_hmac_key_versions
  description              = "${var.name} audit HMAC integrity key ${each.key}"
  key_usage                = "GENERATE_VERIFY_MAC"
  customer_master_key_spec = "HMAC_256"
  deletion_window_in_days  = 30
  # AWS KMS automatic rotation is not supported for HMAC keys.

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "audit_hmac_version" {
  for_each      = var.audit_hmac_key_versions
  name          = "alias/${var.name}-audit-hmac-${each.key}"
  target_key_id = aws_kms_key.audit_hmac[each.key].key_id
}

resource "aws_kms_alias" "audit_hmac_current" {
  name          = "alias/${var.name}-audit-hmac"
  target_key_id = aws_kms_key.audit_hmac[var.current_audit_hmac_key_version].key_id
}

moved {
  from = aws_kms_key.audit_hmac
  to   = aws_kms_key.audit_hmac["v1"]
}

moved {
  from = aws_kms_alias.audit_hmac
  to   = aws_kms_alias.audit_hmac_current
}

resource "aws_dynamodb_table" "auth" {
  name         = "${var.name}-auth"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.data.arn
  }
  deletion_protection_enabled = true
}

resource "aws_dynamodb_table" "audit" {
  name         = "${var.name}-audit"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.data.arn
  }
  deletion_protection_enabled = true
}

resource "aws_secretsmanager_secret" "oidc" {
  count                   = var.oidc_secret_arn == null ? 1 : 0
  name                    = "${var.name}/oidc"
  description             = "Bootstrap externally; Terraform intentionally creates no secret version"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret" "readiness" {
  count                   = var.readiness_evidence_secret_arn == null ? 1 : 0
  name                    = "${var.name}/readiness-evidence"
  description             = "Bootstrap externally; Terraform intentionally creates no secret version"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = 30
}

locals {
  oidc_secret_arn      = coalesce(var.oidc_secret_arn, try(aws_secretsmanager_secret.oidc[0].arn, null))
  readiness_secret_arn = coalesce(var.readiness_evidence_secret_arn, try(aws_secretsmanager_secret.readiness[0].arn, null))
  managed_audit_hmac_key_arns = [
    for version in sort(tolist(var.audit_hmac_key_versions)) :
    aws_kms_key.audit_hmac[version].arn
  ]
  current_audit_hmac_key_arn = aws_kms_key.audit_hmac[var.current_audit_hmac_key_version].arn
  audit_hmac_verify_key_arns = concat(
    local.managed_audit_hmac_key_arns,
    var.previous_audit_hmac_key_arns,
  )
}