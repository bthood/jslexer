/**
 * The MIT License (MIT)
 *
 * Copyright (c) 2013 Byron Hood.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 *
-----
 *
 * To properly lex a string of data, we must construct a DFA such that reading
 * a sequence of characters corresponding to a valid token causes the DFA to
 * enter an accept state.
 *
 * The syntax of most languages is best modeled using multiple 'rules', each
 * of which defines a particular class of token. Each of these rules includes
 * a regular expression defining the class of valid strings. Since a regular
 * expression also corresponds to a DFA, we can model each rule as an individual
 * DFA, and stitch them all together with ORs.
 *
 * This large DFA is fed input until we find the longest matching string. This
 * is essentially the last mini-DFA to be in an accept state before all of the
 * mini-DFAs enter a no-match sink state. The matching string is processed and
 * then appended to a list of tokens. If the input does not match any valid
 * token, then skip ahead to the first valid token in the stream, and report a
 * syntax error on the characters skipped.
 *
 * Partly inspired by js-lex (github.com/cweider/js-lex).
 */

String.prototype.format = function () {
    var args = arguments;
    this.replace(/\{(\d+)\}/g, function (match, p1) {
        var v1 = parseInt(p1) + 1;
        return (v1 < args.length) ? args[v1] : p1;
    });
};

var Lexer = typeof(Lexer) != 'undefined' ? Lexer : function (rules) {

   /**
    * Abstraction for the current state of the lexer, without exposing all of
    * the internals of the lexer object.
    *
    * @param line [int] - the current line number.
    * @param offset [int] - the offset within the current line.
    */
   var State = function (line, offset) {
      this.line = line;
      this.offset = offset;
      this.updated = false;
   };

   /**
    * Abstraction representing a single lexing rule. Each rule contains its
    * regular expression pattern, an identifying label, and a callback.
    *
    * @param name [String] - a label to identify this rule. This is mostly for
    *    the purpose of labeling your tokens for easy recognition later on.
    * @param pattern [RegExp] - the regular expression designating what text
    *    matches this rule. Captures will be passed to the callback function.
    * @param callback [Function, optional] - a callback that is executed when
    *    this token is matched. This function should accept two arguments:
    *    (1) the list of matches (as in String::match), and (2) a LexerState
    *    object representing the current state of the lexer (e.g. current line
    *    and offset). If this function is not provided, the whole string that
    *    matched will be added to the list of tokens.
    * @param discard [boolean, optional] - whether to discard this token after
    *    processing instead of adding it to the list of tokens. Defaults to
    *    false (in other words, add the token to the list).
    */
   var Rule = function (name, pattern, callback, discard) {
      this.name = name;
      this.pattern = pattern;
      this.callback = callback;
      this.discard = discard;

      // Return the number of captures in the pattern.
      this.numCaptures = function () {
         if (this._numCaptures) {
            return this._numCaptures;
         } else {
            // The first alternative ensures that escaped characters do not
            // interfere with the next two. The second matches open-parens
            // inside a character class, but does not capture them (with the
            // result that the callback ignores them). The final alternative
            // matches capture groups and guards against false positives from
            // lookaheads [(?:, (?!, (?=].
            var capture_exp = /\\.|(?:\[(?:\\.|[^\]])*\])|(\((?!\?[!:=]))/g;
            var numCaptures = 0;
            this.pattern.replace(capture_exp, function (match, p1) {
               if (p1) { ++numCaptures; }
               return '';
            });
            this._numCaptures = numCaptures;
            return this._numCaptures;
         }
      };

      // Update backreferences to account for backreferences in previous rules
      // once all rules are combined into a single long regex.
      this.updateReferences = function (offset) {
         // The first 2 alternatives avoid matching backreferences inside
         // character classes, since these are not supported by Javascript, and
         // backreferences with extra leading backslashes.
         var backref_exp = /\[(?:\\.|[^\]])+\]|\\\D|\\(\d+)/g;
         var rule = this;
         this.pattern = this.pattern.replace(backref_exp, function (match, p1) {
            if (!p1) {
               return match;  // ignore: the first alternative matched
            } else {
               var backref = parseInt(p1, 10);
               if (backref > 0 && backref <= rule.numCaptures()) {
                  return '\\' + (backref + offset + 1);  // add 1 for whole-rule capture
               } else {
                  return parseInt(p1, 8); // Assume this was an escape sequence?
               }
            }
         });
      };
   };

   // Validate the rules and compile them into one giant regex.
   this.compile = function () {
      this._rules = []
      if (!rules || !(rules instanceof Array) || rules.length == 0) {
         throw new Lexer.ValidationError(null, 'no rules provided');
      }
      var totalCaptures = 0, overallExp = '';
      for (var i = 0; i < rules.length; ++i) {
         var rule = rules[i];
         if (!rule) {
            throw new Lexer.ValidationError(i + 1, 'invalid rule');
         } else if (!rule.name) {  // Rule must be named.
            throw new Lexer.ValidationError(i + 1, 'missing name');
         } else if (typeof(rule.name) != 'string' || rule.name.length == 0) {  // Rule must be named.
            throw new Lexer.ValidationError(i + 1, 'invalid name "{1}"'.format(rule.name));
         } else if (!rule.pattern) {  // Rule pattern is mandatory.
            throw new Lexer.ValidationError(rule.name, 'missing pattern');
         } else if (!(rule.pattern instanceof RegExp || typeof(rule.pattern) == 'string') ) {
            throw new Lexer.ValidationError(rule.name, 'invalid pattern "{1}"'.format(rule.pattern));
         } else if (rule.callback && !(rule.callback instanceof Function)) {
            throw new Lexer.ValidationError(rule.name, 'invalid callback "{1}"'.format(rule.callback));
         }
         var expression = (rule.pattern instanceof RegExp) ?
            rule.pattern.source : rule.pattern.replace(/[-.*+?^$()\[\]{}\\]/g, '\\$1')
         expression = expression.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
         var r = new Rule(rule.name, expression, rule.callback, !!rule.discard);
         r.updateReferences(totalCaptures + 1);
         totalCaptures += r.numCaptures() + 1;
         this._rules.push(r);
         overallExp += '|({1})'.format(expression);
      }
      // Add a special default rule to deal with HTML line breaks.
      this._rules.unshift(
         new Rule('HTML_BREAK', '<br\\s*\\/?\\s*>', function (captures, lexState) {
            lexState.line += 1;
            lexState.offset = 1;
            lexState.updated = true;
            return null;
         }, true));
      overallExp = '(<br\s*\/?\s*>)' + overallExp;
      this._languageRegex = new RegExp(overallExp, 'gm');
   }

   // Try to recognize the text.
   this.lex = function (text) {
      if (!this._languageRegex) {
         this.compile();
      }
      var tokens = [], lexer = this, startIndex = 0, startTime = new Date();
      this.state = new State(1, 1);
      text.replace(this._languageRegex, function () {
         var matchIndex = arguments[arguments.length-2];
         if (matchIndex > startIndex) {
            console.log('{1}:{2}: skipped unexpected characters "{3}"'.format(
               lexer.state.line, lexer.state.offset, text.slice(startIndex, matchIndex)));
            lexer.state.offset += (matchIndex - startIndex);
         }
         // Iterate sequentially through all of the rules, and all of their
         // respective captures, until one of the captures is found to have
         // been triggered. Save that rule and break out of the loops to
         // continue processing. This is guaranteed to select at least one of
         // the rules because there must have been a match to get here.
         var rule = null, val = arguments[0];
         for (var i = 0, captureIndex = 1; i < lexer._rules.length; ++i) {
            var n = lexer._rules[i].numCaptures() + 1;
            for (var j = 0; j < n; ++j, ++captureIndex) {
               if (arguments[captureIndex]) {
                  rule = lexer._rules[i];
                  break;
               }
            }
            if (rule) { break; }
         }
         // Call the callback action if one is defined.
         if (rule.callback) {
            var matches = Array.prototype.slice.call(
                  arguments, captureIndex, captureIndex + rule.numCaptures() + 1);
            val = rule.callback.call(rule, matches, lexer.state);
         }
         // Discard the token if requested or the callback returns null.
         if (!rule.discard && val != null) {
            tokens.push(new Lexer.Token(rule.name, val, lexer.state));
         }
         // Add the matched token length to the offset if it hasn't already been
         // updated by the callback function.
         if (!lexer.state.updated) {
            lexer.state.offset += arguments[0].length;
         } else { // Clear the updated flag for the next iteration.
            lexer.state.updated = false;
         }
         startIndex = matchIndex + arguments[0].length;
         return '';  // remove these chars so they can't generate more matches.
      });
      var endTime = new Date() - startTime;
      console.log('time:', endTime, 'ms', tokens.slice(0, 100));
      return tokens;
   }
};

// Default rules separate whitespace from non-whitespace.
Lexer.Languages = {
   'default': [
      { name: 'WHITESPACE', pattern: /\s+/, discard: true },
      { name: 'WORD', pattern: /\w+|./ }
   ]
};

// Represents a token.
Lexer.Token = function (name, content, lexState) {
   this.name = name;
   this.content = content;
   this.position = { line: lexState.line, column: lexState.offset };

   this.toString = function () {
      return this.name;
   }
}

// Get a stack trace from an exception.
Lexer.StackTrace = function () {
   // create a fake exception
   try {
      var fake = 0;
      fake.doFake();
   } catch (e) {
      return e.stack;
   }
}

/**
 * The error thrown when the rules for a language are incorrectly specified.
 */
Lexer.ValidationError = function (rule, msg) {
   this.name = 'Lexer.ValidationError';
   this.message = msg;
   this.rule = rule;
   this.stack = Lexer.StackTrace();

   // Return a nicely formatted error string.
   this.toString = function () {
      var result = 'Validation Error: ';
      if (rule) {
         // If the rule name is a string, surround in quotes.
         result += 'in rule ' + (rule.indexOf ? '"' + rule + '"' : rule);
      }
      return result + msg;
   }
}
//Lexer.ValidationError.prototype = new SyntaxError();